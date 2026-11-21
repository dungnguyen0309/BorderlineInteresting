"""Build data/people/photos.json: up to six photos of people and daily life per country.

Subjects come from Wikidata (CC0): festivals and celebrations, traditional dress, folk dances and folk music,
markets and bazaars, and well-known dishes, linked to the country by P17 (country) or P495 (country of origin)
and carrying an image (P18), ranked by sitelink count. Wikimedia Commons gives each file's licence, author,
size, categories, description, date, depicted subjects, coordinates and a thumbnail. Kept: freely licensed
raster photos, 800 px or more on the long side, that are not paintings, scans, sheet music, collages, maps,
flags, logos, posters or museum pieces, that do not show a person with a Wikidata item, and that were not
taken in another country by their coordinates, categories or description. Dress and folk music photos must
show people; market and dance photos filed as buildings must too. Standard library only; shares helpers with
build_photos.py.
Run after build_data.py:  python scripts/build_people_photos.py
"""
import collections
import datetime
import json
import re
import time
import urllib.parse

import build_photos
from build_photos import ALIAS, BACK, COMMONS, EXTRA_QIDS, ROOT, get, is_photo_name, licence, plain, sparql

build_photos.UA["User-Agent"] = "Hinterland-research-map/1.0 (static site build script)"  # the dict get() sends

MAP_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json"  # the app's own country shapes
PER_COUNTRY = 6
POOL = 12  # candidates per country and kind checked on Commons; many fail the licence, size or content rules
KINDS = ("festival", "dress", "dance", "market", "food")  # order of preference when a country has all five
# (country or "*", file), or (country, subject title), checked by hand and left out, for the reason above each group.
SKIP = {
    # A named person or band is the subject.
    ("*", "Princess Maha Chakri Sirindhorn 2010-12-7.jpg"), ("*", "Bino Branco.jpg"),
    ("*", "الملك سلمان بن عبدالعزيز آل سعود يؤدي العرضة السعودية.jpg"),
    ("*", "Os Tubarões 2017 by Nicola Di Nunzio (DNN 6755).jpg"), ("*", "Gopiasan-and-harinarayanan (4506992629).jpg"),
    ("*", "Astro - Festival Primavera Fauna 2011.jpg"), ("*", "Reina del Sol 2009 - 02.jpg"),
    ("*", "20170525-DM-LSC-0229 (34773227612).jpg"),
    # Taken in another country, by the file's own description.
    ("*", "Chicken dance 01 - Ballard Seafood Fest 2007.jpg"), ("*", "Italian Folk Musicians in Edinburgh.JPG"),
    ("*", "Representación del Chuchumbé en un fandango, Veracruz, México..jpg"),
    ("*", "Portuguese Fook Dancing in Kockelscheuer, Luxembourg.jpg"), ("CUB", "CCMDonation28.JPG"),
    ("*", "Ist di Cultura giapponese - altare della festa delle bambole P1100919.JPG"), ("JPN", "Sankai Juku.jpg"),
    ("IRN", "Katong laksa.jpg"), ("SRB", "Çamlıhemşin -- Muhlama (5019844858).jpg"), ("EGY", "Sultanahmet Köftesi.jpg"),
    ("DZA", "Moroccan tajine with meat.jpg"), ("SYR", "Bulbulyuvasi, Turkish dessert.jpg"),
    ("RUS", "2023 Sałatka jarzynowa (1).jpg"),
    # Wikidata's image is of another dish.
    ("ALB", "Giò thủ.jpg"), ("PRY", "Suquet de peix.jpg"),
    # No people or daily life: documents, objects, buildings, military, a painting.
    ("*", "Argentina. Acta de Independencia (Provincias Unidas en Sud-América).jpg"),
    ("*", "Ticket du festival We love eya.jpg"), ("*", "Dog on a stick.jpg"), ("*", "Mascotte tuSeo.jpg"),
    ("*", "OHB Arnoldova vila.jpg"), ("*", "Placa de la Diada Nacional de Catalunya.jpg"), ("*", "Osalejate lipud.jpg"),
    ("*", "SAMEBA.jpg"), ("*", "Force armée guinéen 03.jpg"), ("*", "Stadion of Nemea.jpg"),
    ("*", "Classic vintage hungarian chrismast-tree.jpg"), ("*", "Sanur Beach.JPG"),
    ("*", "Bavar-373 upgrade ceremony (06).jpg"), ("*", "Almaty City Hall (14933818769).jpg"),
    ("*", "Бронеразведывательная машина SandCat.JPG"),
    ("*", "27.08.2026 - Paradă militară dedicată Zilei Independenței - 55491740456.jpg"),
    ("*", "Stone Pillar of Independence Myanmar.JPG"), ("*", "Place de la concorde nationale Tchintabaraden 02.jpg"),
    ("*", "Norfolk Island jail1.jpg"), ("*", "Livestock festivalområde 2017.jpg"), ("*", "The Matariki Stars.png"),
    ("*", "AguinaldoShrinejf0944 13.JPG"), ("*", "Romanian sailing ship Mircea 2.jpg"), ("*", "Парад кораблей 1 СС Алагез.JPG"),
    ("*", "Pro-TEST ob državni proslavi 1.JPG"), ("*", "Labor Day New York 1882.jpg"), ("*", "Reunification day banner.jpg"),
    ("*", "Marche solemnelle du Grand-Seigneur, le jour du Bairam - Melling Antoine Ignace - 1819.jpg"),
    ("*", "Fsk - per nder te 5 vjetorit te Pavaresise.jpg"), ("*", "Hangar - Autostrada Biennale.jpg"),
    ("*", "Józef Chełmoński - Oberek (1878).jpg"), ("*", "Rapid Trident 2014 06.jpg"), ("*", "Mega Shygys Aktobe.jpg"),
    ("*", "Matakana Dairy Company (former) from W.jpg"), ("*", "Gariunai Marked and 3rd Vilnius power station.jpg"),
    ("*", "Basareneforside.JPG"), ("*", "Toqi Telpakfurushon from the north.jpg"), ("*", "Pagne KITA 05.jpg"),
    ("*", "Jazaar.jpg"), ("*", "Makedonija140.jpg"), ("*", "Moana Fresh 20250804 171112.jpg"),
    ("*", "The Killers presentación en el Festival Estéreo Picnic 2013.JPG"), ("*", "Fond de scène 14è édition.jpg"),
    ("*", "升国旗 - panoramio.jpg"), ("*", "The East Moscow in Night.JPG"), ("*", "TCBarabashovo.jpg"),
    ("*", "Zuidlaren, het Zuidlaardermarktmonument foto2 2014-07-12 11.42.jpg"), ("*", "Aleppo Khan al-Wazir 9817 02.jpg"),
    ("*", "Oyingbo Ultramodern Market.jpg"), ("*", "Zieleniak banacha.jpg"), ("*", "Firenze-mercato.jpg"),
    ("*", "Mercado Central de Concepción 2010.jpg"), ("*", "Juanes en Festival REC 2023.jpg"),
    ("*", "Pasar Awam Bagan Ajam, Taman Terbilang 20240916 175217.jpg"), ("*", "Round Market SPB.jpg"),
    ("*", "Aleppo Khan al-Jumruk 9162.jpg"), ("*", "Kharkiv Central Market (01).jpg"),
    ("*", "Aleppo Khan al-Jumruk 9161.jpg"), ("*", "Vyborg MarketHall 006 9067.jpg"), ("*", "Sadovod 19 sep 2023.jpg"),
    ("*", "São Nicolau-Mercado Ferreira Borges.jpg"), ("*", "Day of Interethnic Harmony Ukraine.jpg"),
    ("*", "Woman Gallery in Rear Synagogue in Třebíč, Třebíč District.jpg"), ("*", "Aleppo Khan al-Jumruk 9160.jpg"),
    ("*", "FN13 Antti.jpg"), ("*", "Spasskaya Bashnya (festival) 2013 by shakko 06.jpg"),
    ("*", "Центральний критий ринок Івано-Франківськ.jpg"), ("*", "Ulaz u nekadašnji bezistan u Skoplju.JPG"),
    ("*", "Piazza delle Erbe - Palazzo Maffei (Verona).jpg"), ("*", "Causeway Bay Market (full view and blue sky).jpg"),
    ("*", "Leadenhall Market In London - Feb 2006 rotated.jpg"), ("*", "Центральный рынок гомель 2.jpg"),
    ("*", "Proti Proudu (Kryštof).jpg"), ("*", "Ямской (1).JPG"), ("*", "Mercado Municipal de Maipú 2022 - 07.jpg"),
    # After review. Filed under blackface on Commons, and filmed in Auckland.
    ("*", "Niuean dancing.jpg"),
    # A painting, a music score and a costume-book plate.
    ("*", "Gopak.jpg"), ("*", "Ojo al toro.jpg"), ("*", "012 Grundlseetrachten um 1875.jpg"),
    # Taken in another country, by the file's description or categories: Buenos Aires, Mexico City, London,
    # Paris, Portugal, South Korea; dishes in Chicago, Texas, the USA, Jakarta, Copenhagen, Benin, France,
    # Albania, Spain and Bangladesh.
    ("URY", "Tango dance 02.jpg"), ("URY", "Tango BuenosAires.jpg"), ("URY", "Picada cordobesa.jpg"),
    ("GTM", "Voladores de la feria del mole 2014 45.JPG"), ("CHL", "The Chakaymanta Dance School (7).jpg"),
    ("DOM", "Merengue dancing.jpg"), ("KHM", "Royal Ballet Camboda Apsara Mera.jpg"),
    ("NLD", "Costumes-Maroesjka-Heeze-1989.jpg"), ("PRK", "Korean.Dance-03.jpg"), ("GRC", "Saganaki.jpg"),
    ("NGA", "SuyavarietiesTX.JPG"), ("BTN", "Bhutanese hemadatsi.jpg"), ("SGP", "Kwetiau Siram.jpg"),
    ("KHM", "Char Kh’nhei at Khmer Cuisine (2).jpg"), ("NER", "Dambu.jpg"), ("DZA", "Mtewem.jpg"),
    ("*", "Japrak 1.jpg"), ("MEX", "Quesadilles de Blanes amb salses.jpg"), ("IRN", "ঘরে তৈরি ফালুদা.JPG"),
    # A military ceremony; empty market buildings; a poverty food shown as a national dish.
    ("*", "Narodowe Święto Niepodległości 2012 01.JPG"), ("*", "Municipal Market of Dili, 2023 (03).jpg"),
    ("*", "Guantánamo CF9A1071.jpg"), ("*", "Nikolskie ryady market, Saint Petersburg, Russia.jpg"),
    ("*", "Souk Al Bahar @ Downtown Dubai (15691824350).jpg"), ("*", "SalamancaPlace2008.jpg"),
    ("*", "Spitalfields market 01.JPG"), ("*", "Haitian Dirt Biscuits.jpg"),
    # Viewed after the fix run: market buildings from outside, a president's group photo, a band's advert.
    ("*", "Şərg bazarı - panoramio.jpg"), ("*", "Hales Market - panoramio.jpg"), ("*", "Mercado de Campo de Ourique 01.jpg"),
    ("*", "Novi Sad, Bulevar Oslobođenja, Futoška pijaca.jpg"), ("*", "SouthYarra---Prahran-Market.jpg"),
    ("*", "Mercado Puerto, Valparaíso 20200207 63.jpg"), ("*", "Městská tržnice (Olomouc).JPG"),
    ("*", "Moscow, Nakhimovsky-Lomonosovsky-Vavilova intersection, market Apr 2026 03.jpg"),
    ("*", "Андреевский рынок. Большой проспект Васильевского острова, 18.jpg"), ("*", "Δημοτική Αγορά Χανίων 0468.jpg"),
    ("*", "Vagif Poetry Days in Shusha 2021 (2).jpg"), ("*", "Serenata Grupo Llanero Alma llanera Show 3142196105 - 2094170.jpg"),
    ("*", "Vasmoy Bazaar in 2025.jpg"), ("*", "Mercado La Viseca, Santiago 20200204 05.jpg"),
    ("*", "Larkin Public Market and Bazaar.jpg"), ("*", "Šekspir festival02.jpg"),
    # A US stock photo of apples for an Azerbaijani festival; a German dish photo for Russia; a Pixabay photo
    # whose description is an unrelated advert.
    ("*", "Apples.jpg"), ("RUS", "Sülze001.jpg"), ("*", "Inside Kapani Market.jpg"),
    # Empty streets and market buildings (one now a cinema); Spanish melindros for Italian savoiardi; a Kerala
    # appam for Sri Lanka.
    ("*", "La rue des récréatrales 08.jpg"), ("*", "Чаршија - Крушево (1).png"), ("*", "Satelitska pijaca02.jpg"),
    ("*", "Etnoteatri - Kukaj17.jpg"), ("*", "Hafenmarkt Rhodos01.jpg"), ("*", "Ex Mercato del bestiame (Bologna) abc2.jpg"),
    ("ITA", "Melindros.jpg"), ("LKA", "Paalappam.JPG"), ("LKA", "Pesaha Appam Indari Appam, പെസഹ അപ്പം, ഇണ്ട്രി അപ്പം.JPG"),
    ("*", "Ex mercato pesce salerno.jpg"), ("*", "Šabački Oktobarski salon 01.jpg"), ("*", "Etnoteatri - Kukaj20.jpg"),
    ("*", "Most u Ćupriji 02.jpg"),  # a bridge, for a fish-soup festival
    # (country, subject title): every photo of appam on Commons that reaches Sri Lanka is from Kerala, India.
    ("LKA", "appam"),
}


def of(*classes):
    return f'VALUES ?type {{ {" ".join("wd:" + q for q in classes)} }} ?item wdt:P31 ?type .'


# (kind, how ?item and ?type are matched, minimum sitelinks); each query stays under Wikidata's 60-second limit.
BATCHES = [
    ("festival", of("Q132241"), 2),  # festival
    ("festival", of("Q4618", "Q2390665", "Q13930359", "Q130748394", "Q64272108", "Q2304773", "Q1472127",
                    "Q1435951", "Q12287732"), 1),  # carnival .. traditional festival
    ("festival", of("Q1445650", "Q1197685", "Q375011"), 2),  # holiday, public holiday, religious holiday
    ("festival", of("Q657449", "Q898830", "Q115665045", "Q1644573", "Q2627975"), 1),  # parade .. ceremony
    # Traditional and folk costumes, and the garments filed under them (áo dài, bunad, kira) as subclasses.
    ("dress", "VALUES ?type { wd:Q3172759 wd:Q20917313 } ?item (wdt:P31|wdt:P279)+ ?type .", 1),
    ("dress", of("Q11460"), 2),  # clothing (kimono, hanbok)
    ("dance", of("Q107357104", "Q201022", "Q11639"), 1),  # type of dance, folk dance, dance
    # Music genres, folk ones only: folk music, traditional folk music.
    ("dance", of("Q188451") + " ?item wdt:P279* ?root . VALUES ?root { wd:Q43343 wd:Q235858 }", 2),
    ("market", of("Q132510", "Q330284", "Q219760", "Q510177", "Q1962840", "Q1945774", "Q385870", "Q131690359",
                  "Q2080521"), 1),  # market .. market hall
    ("food", of("Q746549", "Q97659338", "Q1391582", "Q19861951"), 2),  # dish, dish, national dish, type of dish
    ("food", of("Q2095"), 3),  # food
]
# Festivals and markets are in one country; dress, dances and dishes may be shared by two (hanbok, tango).
MAX_COUNTRIES = {"festival": 1, "market": 1, "dress": 2, "dance": 2, "food": 2}
# Subjects that are not celebrations of daily life, or whose pictures are of named people, objects or buildings.
NOT_SUBJECT = {
    "festival": re.compile(r"(?i)^\d{4}|film|cinema|movie|series|television|\btv\b|award|jury|press|anniversary|"
                           r"war\b|veteran|fallen|martyr|memorial|monument|remembrance|genocide|massacre|victim|army|"
                           r"armed forces|military|protest|combatant|liberation|soldier|police|terror|holocaust|"
                           r"mourning|tragedy|bombing|uprising|revolution|victory|grave|tomb|cemetery|stage|bühne|"
                           r"amphitheat|militar|navy|naval|defender|fatherland|missile|ticket|mascot|plaque|placa|"
                           r"banner"),
    "dress": re.compile(r"(?i)medal|order\b|order of|cross\b|star\b|prize|award|badge|decoration|insignia|jersey|"
                        r"classification|space ?suit|egg|armou?r|helmet|boot|shoe|sneaker|jordan|poppy|military"),
    # Pop, rock and club genres (folk rock, folk metal, hip hop dance) are illustrated with named performers.
    "dance": re.compile(r"(?i)rock|metal|pop\b|punk|indie|psych|electro|hip.?hop|rap\b|techno|house|disco|jazz|blues|"
                        r"anti-folk|contemporary|neofolk|freak|new weird|folktronica"),
    # A market square (rynek, Marktplatz, náměstí) is a town square, photographed as one.
    "market": re.compile(r"(?i)market square|\brynek\b|marktplatz|náměstí|"
                         r"stadi|arena|mall\b|shopping|mosque|masjid|مسجد|church|cathedral|inscription|ворота|"
                         r"\bgates?\b|entrance|entrada|entrata|eingang|\bulaz\b|fachada|fa[cç]ade|fassade|exterior"),
}
# Markets whose only class is market hall are buildings, photographed empty from outside.
BUILDING_ONLY = {"Q2080521"}
# Commons categories of a market photo that say it shows the building or a sign, not the market at work.
NOT_MARKET_SCENE = re.compile(r"(?i)\bexteriors?\b|fa[cç]ades?\b|\bentrances?\b|\bgates?\b|shopping malls|road signs")
# Commons categories or description of a festival photo that say it shows a military parade or ceremony.
MILITARY = re.compile(r"(?i)militar|\barmy\b|soldiers?\b|troops\b|guard of honou?r")
# Commons categories of a market or dance photo that say it shows a building; dropped unless people are named.
BUILDING = re.compile(r"(?i)\bbuildings\b|architecture|music venues|convention cent")
# File names and Commons categories of things that are not photos of people or daily life: also "Hopak in
# art", PD-Art (a reproduced artwork), book scans, sheet music, collages, montages and blackface.
NOT_LIFE = re.compile(r"(?<![a-z])(in art|pd-art|scans?|sheet music|collages?|montages?|blackface|"
                      r"poster|affiche|cartel|plakat|mannequins?|stamps?|banknotes?|coins?|museum|mus[eé]e|"
                      r"museo|museu|muzeum|muzej|paintings?|drawings?|illustrations?|engravings?|etchings?|"
                      r"lithographs?|woodcuts?|watercolou?rs?|sketch(es)?|statues?|sculptures?|figurines?|dolls?|"
                      r"toys?|menu|album covers?|book covers?|screenshots?|logos?|maps? of|flags? of|coats? of arms|"
                      r"portraits?|recipes?|clip ?art|vector|ukiyo-e|woodblock|prints?|documents?|manuscripts?)(?![a-z])")
# Words in a file's name or categories that say it shows people.
PEOPLE = re.compile(r"(?<![a-z])(people|persons?|women|woman|men|man|girls?|boys?|children|child|kids|crowds?|"
                    r"dances?|dancers?|dancing|danced|musicians?|performers?|performances?|singers?|singing|players?|"
                    r"wearing|worn|vendors?|sellers?|merchants?|traders?|shoppers?|participants?|brides?|grooms?|"
                    r"couples?|famil(y|ies)|students?|pilgrims?|worshippers?|devotees?|spectators?|audiences?|"
                    r"tourists?|visitors?|costumed|dressed|masks?|masked|personality rights|"
                    # the same in the languages file names use most
                    r"bail(e|ando|arines)|danza|danse|tanz|tänzer\w*|mujer(es)?|hombres|niñ[oa]s|gente|personas|"
                    r"femmes?|hommes|enfants|frauen|kinder|leute|mädchen|crianças|pessoas)(?![a-z])")
# Commons "depicts" values that are people: human, woman, man, girl, boy, child, person, group of humans,
# dance, musician, singer.
PEOPLE_DEPICTS = {"Q5", "Q467", "Q8441", "Q3031", "Q3010", "Q7569", "Q215627", "Q16334295", "Q11639", "Q639669", "Q177220"}


def typed(match, min_sl):
    """Items matched by `match` with an image, and the countries they are in or come from."""
    return sparql(f"""
SELECT ?item ?type ?c ?img ?sl ?en WHERE {{
  hint:Query hint:optimizer "None" .
  {match}
  ?item wikibase:sitelinks ?sl . FILTER(?sl >= {min_sl})
  ?item wdt:P18 ?img .
  ?item wdt:P17|wdt:P495 ?c .
  FILTER NOT EXISTS {{ ?item wdt:P576 ?gone }}
  OPTIONAL {{ ?item rdfs:label ?en FILTER(LANG(?en) = "en") }}
}}""")


def country_items(isos):
    values = " ".join(f'"{ALIAS.get(i, i)}"' for i in isos)
    rows = sparql(f"""
SELECT ?iso ?c WHERE {{
  VALUES ?iso {{ {values} }}
  ?c wdt:P298 ?iso . FILTER NOT EXISTS {{ ?c wdt:P576 ?gone }}
}}""")
    return {**EXTRA_QIDS, **{r["c"]: BACK.get(r["iso"], r["iso"]) for r in rows}}


def commons_info(files, width="640"):
    info, pageid = {}, {}
    for i in range(0, len(files), 50):
        batch = files[i:i + 50]
        d = get(COMMONS, {"action": "query", "format": "json", "formatversion": "2", "prop": "imageinfo",
                          "iiprop": "url|extmetadata|size|mime", "iiurlwidth": width, "iiextmetadatalanguage": "en",
                          "iiextmetadatafilter": "LicenseShortName|LicenseUrl|Artist|NonFree|Categories|GPSLatitude|"
                                                 "GPSLongitude|ImageDescription|DateTimeOriginal",
                          "titles": "|".join("File:" + f for f in batch)})
        q = d.get("query", {})
        norm = {n["to"]: n["from"] for n in q.get("normalized", [])}
        for p in q.get("pages", []):
            if p.get("imageinfo"):
                f = norm.get(p["title"], p["title"])[5:]
                info[f], pageid[f] = p["imageinfo"][0], p["pageid"]
        time.sleep(0.5)
    return info, pageid


def depicted(files, pageid):
    """File -> the Wikidata items its Commons structured data says it depicts (P180)."""
    out = collections.defaultdict(set)
    mids = {"M%d" % pageid[f]: f for f in files if f in pageid}
    keys = sorted(mids)
    for i in range(0, len(keys), 50):
        d = get(COMMONS, {"action": "wbgetentities", "format": "json", "props": "claims", "ids": "|".join(keys[i:i + 50])})
        for mid, e in d.get("entities", {}).items():
            for c in (e.get("statements") or e.get("claims") or {}).get("P180", []):
                q = c["mainsnak"].get("datavalue", {}).get("value", {}).get("id")
                if q:
                    out[mids[mid]].add(q)
        time.sleep(0.5)
    return out


def name_runs(file):
    """Runs of two or three capitalised words in a file name, the shape of a person's name."""
    words = re.split(r"[\s_,.()\-–]+", file.rsplit(".", 1)[0])
    caps = [bool(re.fullmatch(r"[A-ZÀ-Þ][a-zß-ÿ'’]+", w)) for w in words]
    return {" ".join(words[i:i + n]) for n in (2, 3) for i in range(len(words) - n + 1) if all(caps[i:i + n])}


def categories(ii):
    return [c for c in (ii or {}).get("extmetadata", {}).get("Categories", {}).get("value", "").split("|") if c]


def description(ii):
    return plain((ii or {}).get("extmetadata", {}).get("ImageDescription", {}).get("value"))


def year(meta):
    """First year in the file's own date ("1 September 2015", "circa 1930", "1875–1935"), or None. Commons
    shows a camera's empty date as 1899-11-30."""
    text = plain((meta.get("DateTimeOriginal") or {}).get("value")).replace("1899-11-30", "")
    years = re.findall(r"(?<!\d)(1[6-9]\d\d|20\d\d)(?!\d)", text)
    return next((int(y) for y in years if int(y) <= datetime.date.today().year), None)


assert year({"DateTimeOriginal": {"value": '<time datetime="2015-09-01">1 September 2015</time>'}}) == 2015
assert year({"DateTimeOriginal": {"value": "circa 1875–1935"}}) == 1875 and year({}) is None
assert year({"DateTimeOriginal": {"value": "1899-11-30"}}) is None


def named_people(files, img_url, info, depicts):
    """Files that show a person with a Wikidata item: used as a person's image (P18), tagged on Commons as
    depicting one, filed in a person's Commons category (P373), or named after one ("Namrata Rai Kathak Dancer")."""
    out = set()
    by_name = collections.defaultdict(set)
    for f in files:
        for n in name_runs(f):
            by_name[n].add(f)
    keys = sorted(by_name)
    for i in range(0, len(keys), 300):
        values = " ".join(f"{json.dumps(n, ensure_ascii=False)}@{lang}" for n in keys[i:i + 300] for lang in ("en", "mul"))
        for r in sparql(f"SELECT DISTINCT ?name WHERE {{ VALUES ?name {{ {values} }} ?h rdfs:label ?name ; wdt:P31 wd:Q5 }}"):
            out |= by_name[r["name"]]
    urls = {img_url[f]: f for f in files}
    keys = sorted(urls)
    for i in range(0, len(keys), 200):
        values = " ".join(f"<{u}>" for u in keys[i:i + 200])
        out |= {urls[r["img"]] for r in sparql(f"SELECT DISTINCT ?img WHERE {{ VALUES ?img {{ {values} }} ?h wdt:P18 ?img ; wdt:P31 wd:Q5 }}")}
    by_item = collections.defaultdict(set)
    for f, qs in depicts.items():
        for q in qs:
            by_item[q].add(f)
    keys = sorted(by_item)
    for i in range(0, len(keys), 300):
        values = " ".join("wd:" + q for q in keys[i:i + 300])
        for r in sparql(f"SELECT ?h WHERE {{ VALUES ?h {{ {values} }} ?h wdt:P31 wd:Q5 }}"):
            out |= by_item[r["h"]]
    by_cat = collections.defaultdict(set)
    for f in files:
        for c in categories(info.get(f)):
            by_cat[c].add(f)
    keys = sorted(by_cat)
    for i in range(0, len(keys), 300):
        values = " ".join(json.dumps(c, ensure_ascii=False) for c in keys[i:i + 300])
        for r in sparql(f"SELECT DISTINCT ?cat WHERE {{ VALUES ?cat {{ {values} }} ?h wdt:P373 ?cat ; wdt:P31 wd:Q5 }}"):
            out |= by_cat[r["cat"]]
    return out


def shapes(key_iso):
    """ISO3 -> rings of the app's country shapes, decoded from the TopoJSON."""
    topo = get(MAP_URL)
    (sx, sy), (tx, ty) = topo["transform"]["scale"], topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x, y = x + dx, y + dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    out = collections.defaultdict(list)
    for g in topo["objects"]["countries"]["geometries"]:
        iso = key_iso.get(g.get("id") or g["properties"]["name"])
        polys = g.get("arcs", []) if g["type"] == "MultiPolygon" else [g.get("arcs", [])]
        for poly in polys:
            for ring in poly:
                out[iso].append([p for a in ring for p in (arcs[a] if a >= 0 else arcs[~a][::-1])])
    return out


def inside(lon, lat, rings):
    """Even-odd rule over all rings, so holes (Lesotho in South Africa) count as outside."""
    hit = False
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
    return hit


def taken_in(ii, rings_by_iso):
    """The country a file's coordinates fall in, or None when it has none or they fall in no shape (sea, coast)."""
    meta = (ii or {}).get("extmetadata", {})
    try:
        lat, lon = float(meta["GPSLatitude"]["value"]), float(meta["GPSLongitude"]["value"])
    except (KeyError, ValueError):
        return None
    return next((iso for iso, rings in rings_by_iso.items() if iso and inside(lon, lat, rings)), None)


# Names that also mean a region of another country (Greek Macedonia, the US state of Georgia) or a river, and
# capitals shared with other towns (Santiago, San Juan, Kingston), a person's name (Sofia) or a word (Praia).
AMBIGUOUS_NAMES = {"America", "Timor", "Georgia", "Jordan", "Macedonia", "Congo", "Victoria", "City of Victoria",
                   "Douglas", "Hamilton", "Kingston", "George Town", "Georgetown", "Jamestown", "Plymouth",
                   "Santiago", "San José", "San Juan", "La Paz", "Santo Domingo", "San Salvador", "Tripoli",
                   "Stanley", "The Valley", "Saint-Pierre", "Marigot", "Sofia", "Nassau", "Panama City",
                   "Saint John's", "Saint George's", "Praia", "Diego Garcia", "Adamstown", "Jerusalem"}


def place_names(countries):
    """A function: text -> (countries it names as where the photo was taken, countries it names as the topic).
    Where: "in X", "at X", ", X", "X photographs", "photographs of X", with capitals ("Tango, Buenos Aires",
    "at London's South Bank"), names case-sensitive so "a jersey" is not Jersey. Topic: "of X", "from X"."""
    names, places = {}, {}
    for c in countries.values():
        if not c.get("iso3"):
            continue
        for n in [c["name"], *c.get("alt", []), c.get("capital") or ""]:
            if len(n) >= 4 and n not in AMBIGUOUS_NAMES:
                places[n] = c["iso3"]
                if n != c.get("capital"):
                    names[n.lower()] = c["iso3"]
    alt = "|".join(sorted(map(re.escape, names), key=len, reverse=True))
    at = "|".join(sorted(map(re.escape, places), key=len, reverse=True))
    topic = re.compile(rf"(?i)\b(?:in|of|from)\s+(?:the\s+)?({alt})\b|\b({alt})\s+photographs\b")
    where = re.compile(rf"(?:\b(?i:in|at|photographs of)\s+(?:(?i:the)\s+)?|,\s*)({at})\b|\b({at})\s+photographs\b")
    return lambda text: ({places[m] for pair in where.findall(text) for m in pair if m},
                         {names[m.lower()] for pair in topic.findall(text) for m in pair if m})


def credit(meta):
    """The Artist field's name, without what some Artist fields carry besides it: a hidden licence table, an
    upload-tool badge, a talk-page signature, a request to be notified (then the uploader named in its link is
    the author), a Flickr motto after " --- ", a "User:" prefix or "(talk)" and "(mail)" links. A derivative
    work credits the original author and the person who made it. Names are kept whole."""
    s = (meta.get("Artist") or {}).get("value", "")
    s = re.sub(r"(?s)<table\b.*?</table>|<div\b.*", "", s)
    s = re.split(r"(?i)(?:<br\s*/?>\s*)+(?=If you|Please|Other photos|More (?:of my|photos))", s)[0]
    s = re.sub(r"(?s)\s*\(<a[^>]*User[ _]talk:.*?</a>\)\s*\d\d:\d\d, \d+ \w+ \d{4} \(UTC\)", "", s)
    if re.match(r"(?i)\s*(I would appreciate|Original description was)", s):
        m = re.search(r'title="(?:Special:EmailUser/|User:)([^"&]+)"', s)
        s = m.group(1) if m else ""
    s = plain(s)
    m = re.match(r"No machine-readable author provided\. (.+?) assumed", s)
    s = m.group(1) if m else s
    m = re.match(r"(?i)(?:.+?\.(?:jpe?g|png|tiff?)\s*:\s*)?(.+?)\s+derivative work:\s*(.+)", s)
    s = f"{m.group(1)} (derivative work: {m.group(2)})" if m else s
    s = re.split(r"\s+-{2,}\s+|\s+/\s+Thank", s)[0]
    s = re.sub(r"\s*\([^()]*\b(?:talk|mail|contribs)\s*\)|\s*@\s*Wikimedia Commons", "", s)
    s = re.sub(r"(?<!\w)User:", "", re.sub(r"^\(\s*(.*?)\s*\)$", r"\1", s.strip()))
    s = re.sub(r"\(\s+", "(", s).strip()
    if re.fullmatch(r"(Unknown author ?)+", s):
        return "Unknown author"
    return "Anonymous" if re.fullmatch(r"Anonymous( Unknown author)*", s) else s


assert credit({"Artist": {"value": '<p>Michael A. Zapletal\n</p>\n<table class="licensetpl"><tr><td>Public domain</td></tr></table>'}}) == "Michael A. Zapletal"
assert credit({"Artist": {"value": 'I would appreciate <a href="x" title="Special:EmailUser/Aktron">being notified</a> if you use my work.'}}) == "Aktron"
assert credit({"Artist": {"value": 'Original description was: I, <a href="x" title="User:VirtualSteve">VirtualSteve</a> took this photograph'}}) == "VirtualSteve"
assert credit({"Artist": {"value": '<a href="x" title="User:Vadeve">Vadeve</a> (<a href="y" title="User talk:Vadeve"><span>talk</span></a>) 19:27, 27 November 2012 (UTC)'}}) == "Vadeve"
assert credit({"Artist": {"value": '<a href="x" title="User:Pbdragonwang">祥龍</a><div style="a"><div>This file was uploaded with Commonist.</div></div>'}}) == "祥龍"
assert credit({"Artist": {"value": '<a href="x">Diego Delso</a>'}}) == "Diego Delso"
assert credit({"Artist": {"value": '<p><b><a title="User:Sergiy Bobok">Serhii Bobok</a></b><br><br>If you have any questions please contact me.'}}) == "Serhii Bobok"
assert credit({"Artist": {"value": "Bhutanese_hemadatsi_and_rice.JPG : ShashiBellamkonda derivative work: Thejinan"}}) == "ShashiBellamkonda (derivative work: Thejinan)"
assert credit({"Artist": {"value": "Heribert Pohl --- Thanks for half a million clicks! from Germering, Deutschland"}}) == "Heribert Pohl"
assert credit({"Artist": {"value": "heb @ Wikimedia Commons ( mail)"}}) == "heb" and credit({"Artist": {"value": "Ezagren ( bicara / talk)"}}) == "Ezagren"
assert credit({"Artist": {"value": "Radosław Drożdżewski ( User:Zwiadowca21)"}}) == "Radosław Drożdżewski (Zwiadowca21)"
assert credit({"Artist": {"value": "( User:Zwiadowca21)"}}) == "Zwiadowca21" and credit({"Artist": {"value": "User:P199"}}) == "P199"
assert credit({"Artist": {"value": "Prayitno / Thank you for (12 millions +) view from Los Angeles, USA"}}) == "Prayitno"
assert credit({"Artist": {"value": "<span>Anonymous</span><span>Unknown author</span>"}}) == "Anonymous"
assert credit({"Artist": {"value": "<span>Unknown author</span><span>Unknown author</span>"}}) == "Unknown author"


def photo(c, ii):
    if not ii or ii.get("mime") not in ("image/jpeg", "image/png") or max(ii["width"], ii["height"]) < 800:
        return None
    meta = ii.get("extmetadata", {})
    if NOT_LIFE.search(" | ".join(categories(ii)).lower()):
        return None
    if (c["what"] == "market" and NOT_MARKET_SCENE.search(" | ".join(categories(ii)))
            or c["what"] == "festival" and MILITARY.search(" | ".join(categories(ii)) + " | " + description(ii))):
        return None
    lic, by = licence(meta), credit(meta)
    # As in build_photos.py: Commons serves standard thumbnail widths only and from thumb.wikimedia.org with
    # tracking parameters; the same path works on upload.wikimedia.org.
    thumb = (ii.get("thumburl") or ii.get("url", "")).split("?")[0].replace("https://thumb.wikimedia.org/", "https://upload.wikimedia.org/")
    # An Artist field that links a Wikidata creator item renders as its bare id ("Q139555801"): no usable credit.
    if not lic or not by or re.fullmatch(r"Q\d+", by) or not thumb.startswith("https://upload.wikimedia.org/"):
        return None
    px = re.search(r"/(\d+)px-[^/]+$", thumb)
    w = int(px.group(1)) if px else ii["width"]
    url = (meta.get("LicenseUrl") or {}).get("value", "")
    url = re.sub(r"^(?:https?:)?//", "https://", url) if re.match(r"(?:https?:)?//", url) else None
    return {"title": c["title"], "what": c["what"], "img": thumb, "page": ii["descriptionurl"],
            "author": by, "licence": lic, "licence_url": url, "year": year(meta),
            "w": w, "h": round(ii["height"] * w / ii["width"])}


def shows_people(file, ii, depicts):
    return bool(depicts & PEOPLE_DEPICTS) or bool(PEOPLE.search((file.replace("_", " ") + " | " + " | ".join(categories(ii))).lower()))


def is_life_name(file):
    return is_photo_name(file) and not NOT_LIFE.search(file.lower().replace("_", " "))


assert not is_life_name("Sargent John Singer Spanish Dancer painting.jpg") and not is_life_name("Sari on mannequin.jpg")
assert not is_life_name("Oktoberfest Plakat 1910.jpg") and not is_life_name("Stamps of Moldova, 2013-38.jpg")
assert not is_life_name("Caftan algérien musée du Quai Branly.jpg")
assert is_life_name("Bailando la jota.jpg") and is_life_name("Chatuchak Market (8270018927).jpg")
assert NOT_SUBJECT["dance"].search("folk metal") and NOT_SUBJECT["dance"].search("indie folk")
assert not NOT_SUBJECT["dance"].search("polka") and not NOT_SUBJECT["dance"].search("fado")
assert NOT_SUBJECT["festival"].search("2016 Toronto International Film Festival") and not NOT_SUBJECT["festival"].search("Oktoberfest")
assert NOT_SUBJECT["market"].search("Zimní stadion Karlovy Vary") and not NOT_SUBJECT["market"].search("Grand Bazaar")
assert NOT_SUBJECT["market"].search("Market Square in Ząbkowice Śląskie") and NOT_LIFE.search("hopak in art | pd-art")
assert NOT_LIFE.search("1880s paintings of people | dancing women in art") and not NOT_LIFE.search("maiko | furisode")
assert shows_people("Bailando la jota.jpg", {}, set()) and shows_people("x.jpg", {}, {"Q467"})
assert not shows_people("Mongolian horse violin.JPG", {"extmetadata": {"Categories": {"value": "Morin khuur"}}}, set())
assert {"Namrata Rai", "Namrata Rai Kathak"} <= name_runs("Namrata_Rai_Kathak_Dancer.jpg")
assert not name_runs("Tango_dance_02.jpg") and "Chenxin Liu" in name_runs("Chenxin Liu - Don Quichotte, Kitri.jpg")
_mentions = place_names({"1": {"iso3": "USA", "name": "United States", "alt": ["America"]},
                         "2": {"iso3": "PNG", "name": "Papua New Guinea"}, "3": {"iso3": "GIN", "name": "Guinea"},
                         "4": {"iso3": "ARG", "name": "Argentina", "capital": "Buenos Aires"},
                         "5": {"iso3": "DOM", "name": "Dominican Republic"}, "6": {"iso3": "GBR", "name": "United Kingdom", "capital": "London"},
                         "7": {"iso3": "JEY", "name": "Jersey"}, "8": {"iso3": "NLD", "name": "Netherlands"}})
assert _mentions("Child labor in the United States | Macon") == ({"USA"}, {"USA"})
assert _mentions("Festivals in Papua New Guinea") == ({"PNG"}, {"PNG"})
assert _mentions("Music of Latin America | Guinea pigs as food") == (set(), set())
assert _mentions("Tango dance, Buenos Aires, Argentina") == ({"ARG"}, set())
assert _mentions("Culture of the Dominican Republic | A couple dance at London's South Bank.") == ({"GBR"}, {"DOM"})
assert _mentions("A man in a jersey | 1989 in Portugal | Dancers from the Netherlands") == (set(), {"NLD"})
assert _mentions("2002 photographs of the United States") == ({"USA"}, {"USA"})
_square = [[(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)], [(4, 4), (6, 4), (6, 6), (4, 6), (4, 4)]]
assert inside(2, 2, _square) and not inside(5, 5, _square) and not inside(11, 5, _square)


def main():
    started = time.time()
    countries = json.loads((ROOT / "data" / "countries.json").read_text(encoding="utf-8"))["countries"]
    isos = sorted({c["iso3"] for c in countries.values() if c.get("iso3")})
    qid_iso = country_items(isos)

    cand = {}  # (item, file) -> candidate
    linked = collections.defaultdict(set)  # item -> countries
    types = collections.defaultdict(set)  # item -> classes
    img_url = {}
    for kind, match, min_sl in BATCHES:
        rows = typed(match, min_sl)
        print(f"{kind}: {len(rows)} rows")
        for r in rows:
            iso, title = qid_iso.get(r["c"]), r.get("en")
            if not iso or not title or re.fullmatch(r"Q\d+", title) or r["item"] in qid_iso:
                continue
            file = urllib.parse.unquote(r["img"].rsplit("/Special:FilePath/", 1)[1])
            img_url[file] = r["img"]
            linked[r["item"]].add(iso)
            types[r["item"]].add(r["type"])
            # An item found by two batches keeps the first kind: Flamenco is a dance before it is a genre.
            cand.setdefault((r["item"], file), {"item": r["item"], "file": file, "title": title, "what": kind,
                                                 "score": int(r["sl"])})

    # Shortlist per country and kind. Items tied to more countries (Diwali, pilaf) have one photo, likely
    # taken in another of them.
    short = collections.defaultdict(list)
    for c in sorted(cand.values(), key=lambda c: (-c["score"], c["item"], c["file"])):  # ties by id: same picks each run
        k = c["what"]
        if len(linked[c["item"]]) > MAX_COUNTRIES[k] or not is_life_name(c["file"]):
            continue
        if k in NOT_SUBJECT and NOT_SUBJECT[k].search(c["title"] + " " + (c["file"] if k in ("festival", "market") else "")):
            continue
        if k == "market" and types[c["item"]] <= BUILDING_ONLY:
            continue
        for iso in linked[c["item"]]:
            if len(short[iso, k]) < POOL:
                short[iso, k].append(c)
    files = sorted({c["file"] for lst in short.values() for c in lst})
    print(f"checking {len(files)} files on Commons")
    info, pageid = commons_info(files)
    # Commons rounds 640 up to its 960 px step, so originals up to 960 px wide come back whole: take 500 px.
    small, _ = commons_info([f for f, ii in info.items() if 500 < ii["width"] <= 960], "500")
    for f, ii in small.items():
        info[f].update({k: ii[k] for k in ("thumburl", "thumbwidth", "thumbheight") if k in ii})
    depicts = depicted(files, pageid)
    people = named_people(files, img_url, info, depicts)
    print(f"{len(people)} files show a person with a Wikidata item")
    rings = shapes({k: c.get("iso3") for k, c in countries.items()})
    mentions = place_names(countries)

    out, dropped = {}, collections.Counter()
    for iso in isos:
        per_kind = {}
        for k in KINDS:
            lst = []
            for c in short.get((iso, k), []):
                ii = info.get(c["file"])
                p = photo(c, ii)
                # Garments and folk music genres are often shown as objects (a fez, a morin khuur) without anyone.
                needs_people = k == "dress" or (k == "dance" and "Q188451" in types[c["item"]])
                cats = " | ".join(categories(ii))
                where, about = mentions(c["file"].replace("_", " ") + " | " + cats + " | " + description(ii))
                if not p:
                    dropped["licence, size or content"] += 1
                elif c["file"] in people:
                    dropped["named person"] += 1
                elif {(iso, c["file"]), ("*", c["file"]), (iso, c["title"])} & SKIP:
                    dropped["checked by hand"] += 1
                elif needs_people and not shows_people(c["file"], ii, depicts.get(c["file"], set())):
                    dropped["no people"] += 1
                elif taken_in(ii, rings) not in (None, iso):
                    dropped["taken in another country"] += 1
                elif where - {iso}:  # "in Paris, France" counts whatever "Culture of Cambodia" says
                    dropped["taken in another country, by its text"] += 1
                elif about and iso not in about | where:
                    dropped["about another country"] += 1
                elif k in ("market", "dance") and BUILDING.search(cats) and not shows_people(
                        c["file"], ii, depicts.get(c["file"], set())):
                    dropped["building, no people"] += 1
                else:
                    # Festival and dance photos with people in them go first.
                    weight = 1 if k not in ("festival", "dance") or shows_people(c["file"], ii, depicts.get(c["file"], set())) else 0.5
                    lst.append((c, p, c["score"] * weight * (0.3 if k == "food" else 1)))
            per_kind[k] = sorted(lst, key=lambda x: (-x[2], x[0]["item"], x[0]["file"]))
        chosen, items, files_used, titles = [], set(), set(), set()

        def take(c, p):
            if c["item"] in items or c["file"] in files_used or c["title"] in titles or len(chosen) >= PER_COUNTRY:
                return False
            items.add(c["item"])
            files_used.add(c["file"])
            titles.add(c["title"])
            chosen.append(p)
            return True

        for k in KINDS:  # one of each kind first, then the best of the rest; dishes go last
            next((1 for c, p, _ in per_kind[k] if take(c, p)), None)
        for c, p, _ in sorted((x for k in KINDS for x in per_kind[k]), key=lambda x: (-x[2], x[0]["item"], x[0]["file"])):
            take(c, p)
        if chosen:
            out[iso] = chosen
    print("dropped candidates:", dict(dropped))

    # Self-checks: a changed source format or a bad join shows up here.
    assert len(out) >= 140, len(out)
    assert all(len(v) <= PER_COUNTRY for v in out.values())
    assert any(p["what"] == "festival" for p in out["BRA"]) and any(p["what"] == "food" for p in out["JPN"])
    assert not any(p["title"] == "Groundhog Day" for p in out.get("CAN", []))
    for iso, lst in out.items():
        assert len({p["page"] for p in lst}) == len(lst), iso
        assert all(p["title"] and p["author"] and p["licence"] and p["what"] in KINDS for p in lst), iso
        assert all(p["img"].startswith("https://upload.wikimedia.org/") for p in lst), iso
        assert all(p["year"] is None or 1600 <= p["year"] <= datetime.date.today().year for p in lst), iso
        assert all(p["licence_url"] is None or p["licence_url"].startswith("https://") for p in lst), iso
    assert not any(p["page"].endswith("Niuean_dancing.jpg") for p in out.get("NIU", []))

    data = {"built": datetime.date.today().isoformat(), "countries": out}
    path = ROOT / "data" / "people" / "photos.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    counts = collections.Counter(p["what"] for lst in out.values() for p in lst)
    print(f"wrote {path} ({len(out)} countries; {sum(counts.values())} photos; {dict(counts)}; {time.time() - started:.0f} s)")
    every = [p for lst in out.values() for p in lst]
    print(f"{sum(p['year'] is not None for p in every)} with a year, {sum(bool(p['licence_url']) for p in every)} with a licence link")


if __name__ == "__main__":
    main()

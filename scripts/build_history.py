"""Build data/people/history.json: how 19th- and early 20th-century race typology described each region.

A history-of-science note, not a classification: every claim is attributed to a named author and year,
and the shared note explains why the schemes are wrong. Images are original plates and maps from those
books, taken from Wikimedia Commons and accepted only when Commons marks them public domain.

The texts, captions, authors and years below were checked by hand against scans of the books on the
Internet Archive. Commons is used only for the image URLs, sizes and licence, because its author and date
fields are wrong for several of these files (the "Keane 1899" portraits are from the 1920 revised edition,
the "Ripley 1899" Armenian is from von Luschan 1911, the "Ripley 1899" Piedmont scan is the Popular Science
Monthly printing of 1897, the Deniker figures carry 1906 or 1913 reprint dates).
Standard library only:  python scripts/build_history.py
"""
import datetime
import json
import pathlib
import re
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Borderline-Interesting-research-map/1.0 (static site build script)"}
API = "https://commons.wikimedia.org/w/api.php?"

RIPLEY = ("William Z. Ripley", "1899")
DENIKER = ("Joseph Deniker", "1900")
KEANE20 = ("A. H. Keane, revised by A. Hingston Quiggin and A. C. Haddon", "1920")
MEYERS = ("Gustav Mützel for Meyers Konversations-Lexikon", "1885–90")  # plates signed "G. Mützel fec."
MEYERS_PUB = ("Bibliographisches Institut, Leipzig", "1885–90")  # unsigned map and plate: credit the publisher
BLUMENBACH = ("Johann Friedrich Blumenbach", "1795")

NOTE = (
    "Anthropologists of the 19th and early 20th centuries sorted people into 'races' and 'types'. "
    "Later research found that most human genetic variation lies within populations: Lewontin (1972) "
    "put that share at about 85%, and Rosenberg and colleagues (2002) at 93 to 95%. "
    "Differences between populations build up gradually with geographic distance (Serre and Pääbo 2004; "
    "Rosenberg and colleagues 2005), so head shape, stature and skin colour do not sort people into a few fixed "
    "types, and Boas (1912) found that even the cephalic index of immigrants' children born in the United States "
    "differed from their parents'. "
    "The American Association of Physical Anthropologists' Statement on Race and Racism (2019) concludes that "
    "humans do not fall biologically into separate continental types or genetic race clusters, and that the idea "
    "of race arose from, and served, European colonialism, oppression and discrimination. "
    "Several of the authors quoted here ranked the groups they described, and their portraits were made to "
    "illustrate 'types'; they are shown here only as records of that history."
)

SOURCES = [
    ("De generis humani varietate nativa, 3rd ed.", "Johann Friedrich Blumenbach", "1795", "https://archive.org/details/degenerishumaniv00blum"),
    ("Crania Americana", "Samuel George Morton", "1839", "https://archive.org/details/Craniaamericana00Mort"),
    ("On the Geographical Distribution of the Chief Modifications of Mankind", "Thomas H. Huxley", "1870", "https://doi.org/10.2307/3014371"),
    ("Meyers Konversations-Lexikon, 4th ed.", "Bibliographisches Institut, Leipzig", "1885–90", "https://archive.org/details/meyerskonversati11meye"),
    ("The World's Inhabitants", "G. T. Bettany", "1888", "https://archive.org/details/worldsinhabitant00bett"),
    ("The Racial Geography of Europe: Italy, Popular Science Monthly 51", "William Z. Ripley", "1897",
     "https://en.wikisource.org/wiki/Popular_Science_Monthly/Volume_51/October_1897/The_Racial_Geography_of_Europe:_Italy_IX"),
    ("The Races of Europe: A Sociological Study", "William Z. Ripley", "1899", "https://archive.org/details/racesofeuropeso00ripl"),
    ("Deniker's Classification of the Races of Europe (with Deniker's map)", "William Z. Ripley", "1899", "https://doi.org/10.2307/2842946"),
    ("Man, Past and Present", "A. H. Keane", "1899", "https://archive.org/details/manpastpresent00kean"),
    ("The Races of Man: An Outline of Anthropology and Ethnography", "Joseph Deniker", "1900", "https://archive.org/details/racesofmanoutlin00deniuoft"),
    ("The People of India", "Herbert Hope Risley", "1908", "https://archive.org/details/peopleindia00rislgoog"),
    ("Changes in the Bodily Form of Descendants of Immigrants", "Franz Boas", "1912", "https://doi.org/10.1525/aa.1912.14.3.02a00080"),
    ("Man, Past and Present, revised edition", "A. H. Keane, A. Hingston Quiggin, A. C. Haddon", "1920", "https://archive.org/details/manpastpresent00keanuoft"),
    ("The Races of Europe", "Carleton S. Coon", "1939", "https://archive.org/details/in.ernet.dli.2015.222580"),
    ("The Apportionment of Human Diversity", "Richard Lewontin", "1972", "https://doi.org/10.1007/978-1-4684-9063-3_14"),
    ("Genetic Structure of Human Populations", "Noah A. Rosenberg et al.", "2002", "https://doi.org/10.1126/science.1078311"),
    ("Evidence for Gradients of Human Genetic Diversity Within and Among Continents", "David Serre, Svante Pääbo", "2004", "https://doi.org/10.1101/gr.2529604"),
    ("Clines, Clusters, and the Effect of Study Design on the Inference of Human Population Structure", "Noah A. Rosenberg et al.", "2005", "https://doi.org/10.1371/journal.pgen.0010070"),
    ("AAPA Statement on Race and Racism", "Agustín Fuentes et al. (American Association of Physical Anthropologists)", "2019", "https://bioanth.org/about/aaba-statement-on-race-racism/"),
]

# key: (title, text, [(commons file, image title, caption, (author, year))])
REGIONS = {
    "nw_europe": ("Northern and western Europe",
        "Ripley (1899) gave the north-west of Europe to his 'Teutonic' type: long head and face, very light hair, "
        "blue eyes, tall stature and a narrow nose. Deniker (1900) described much the same people as a 'Northern race', "
        "with an average height of 1.73 m and a cephalic index (head breadth as a percentage of head length) of 76 to 79, "
        "and placed it in Scandinavia, northern Britain, the northern Netherlands and the Baltic provinces. "
        "Coon (1939) kept the name 'Nordic' but called it a partly depigmented branch of the 'Mediterranean' stock.",
        [("Ripley map of cephalic index in Europe.png", "Cephalic index of Europe",
          "William Z. Ripley, map of the cephalic index, The Races of Europe (1899). Darker shading marks broader, "
          "shorter heads (index up to 87–89); the lighter British Isles, Scandinavia and Iberia mark the long-headed "
          "populations he called Teutonic and Mediterranean.", RIPLEY),
         ("Danish man of classic Nordic type, from Augustus Henry Keane's Man, Past and Present (1899).jpg", "'Dane, Nordic'",
          "Keane, Man, Past and Present, revised edition (1920), plate XI, 2: a Danish man captioned 'Dane (Nordic)'.", KEANE20)]),
    "ce_europe": ("Central and eastern Europe",
        "Ripley (1899) drew a belt of his 'Alpine' type, which other writers called Celtic or Slavic, across central Europe "
        "from France through the Alps and Austria-Hungary towards Russia: round head, broad face, medium and stocky build, "
        "light chestnut hair and hazel-grey eyes. Deniker (1900) added a fair, rather short 'Eastern race' (about 1.63 to "
        "1.64 m, cephalic index 82 to 83) among White Russians (Belarusians) and some Lithuanians, and a 'Vistulian' "
        "sub-race among Poles. His map of 1899 shows the region as a patchwork of principal and secondary races.",
        [("Deniker's Races de l'Europe (1899).jpg", "Deniker's map of Europe",
          "Joseph Deniker's map 'Races de l'Europe', reprinted by Ripley in the Journal of the Anthropological Institute "
          "(1899). The legend lists six principal races (Nordic, Littoral, Oriental, Adriatic or Dinaric, Ibero-Insular, "
          "Occidental or Cévenole) and four secondary ones.", ("Joseph Deniker", "1899")),
         ("Austrian man of Alpine type, from William Z. Ripley's The Races of Europe (1899).png", "'Alpine type', Austria",
          "Ripley, The Races of Europe (1899), plate 'The three European racial types', figs. 21–22: an Austrian man "
          "captioned 'Alpine type. Blue eyes, brown hair. Index 88.'", RIPLEY)]),
    "s_europe": ("Southern Europe",
        "Ripley (1899) assigned the Mediterranean shores to a 'Mediterranean' type: long-headed and long-faced like his "
        "northern type, but with dark brown or black hair, dark eyes and a medium, slender build. Deniker (1900) split the "
        "south into a very short, long-headed 'Ibero-insular race' (1.61 to 1.62 m, index 73 to 76) in Iberia and the "
        "western Mediterranean islands, a taller 'Littoral' race along the coasts, and an 'Adriatic or Dinaric race' "
        "(1.68 to 1.72 m, index 85 to 86) whose purest examples he placed in Bosnia, Dalmatia and Croatia. "
        "Ripley also placed round-headed 'Alpine' populations in northern Italy, above all in Piedmont.",
        [("Catalan man of classic Iberian type, from Augustus Henry Keane's Man, Past and Present (1899).jpg", "'Catalan, Iberian'",
          "Keane, Man, Past and Present, revised edition (1920), plate XII, 1: 'Catalan man, Spain (Iberian)'.", KEANE20),
         ("Piemontese man of Alpine type, from William Z. Ripley's The Races of Europe (1899).png", "'Alpine type', Piedmont",
          "Ripley, 'The Racial Geography of Europe: Italy', Popular Science Monthly 51 (October 1897): a young man "
          "from Piedmont, front and profile, captioned 'Alpine type', cephalic index 91.3. The same photographs are "
          "figs. 79–80 of The Races of Europe (1899).", ("William Z. Ripley", "1897"))]),
    "mena": ("Middle East, North Africa and the Caucasus",
        "Most 19th-century schemes put North Africa and Western Asia inside a broad 'Caucasian' race, a name Blumenbach "
        "(1795) took from the Caucasus, partly because he held its Georgians to be the most beautiful people; his model skull "
        "for it was a Georgian woman's. The Meyers "
        "Konversations-Lexikon (1885–90) split that race into 'Aryans', 'Hamites' and 'Semites', names taken from language "
        "families, and Deniker (1900) described an 'Arab or Semite race', a 'Berber race' with four sub-types, and an "
        "'Assyroid' type among Hadjemi Persians, some Kurdish tribes and some Armenians and Jews, described mainly by "
        "the shape of the nose. Keane's Man, Past and Present (1920 edition) labelled the Beja peoples of Sudan 'Hamite'.",
        [("Meyers b11 s0476a.jpg", "'Verbreitung der Menschenrassen'",
          "'Ethnographische Karte: Verbreitung der Menschenrassen' (distribution of human races), Meyers "
          "Konversations-Lexikon, 4th edition (1885–90). The legend divides humanity into a 'Caucasian', a 'Mongolian' "
          "and a 'Negroid' race, with 'Dravidians and Sinhalese' marked as uncertain.", MEYERS_PUB),
         ("Blumenbach's five races.JPG", "Blumenbach's five skulls",
          "Johann Friedrich Blumenbach, De generis humani varietate nativa, 3rd edition (1795), plate II: skulls labelled "
          "Tungusae, Caribaei, Feminae Georgianae, O-taheitae and Aethiopissae, which stood for his Mongolian, American, "
          "Caucasian, Malay and Ethiopian varieties. The Georgian woman's skull in the middle was his model for the "
          "'Caucasian' variety.", BLUMENBACH),
         ("Bisharin man of classic Hamitic type, from Augustus Henry Keane's Man, Past and Present, full (1899).jpg", "'Bisharin, Hamite'",
          "Keane, Man, Past and Present, revised edition (1920), plate XIII, 1–2: 'Bisharin, Egyptian Sudan (Hamite)', "
          "profile and front.", KEANE20)]),
    "ssa": ("Sub-Saharan Africa",
        "Blumenbach (1795) called the peoples of Africa south of the Sahara the 'Ethiopian' variety, and Keane (1899) made "
        "the 'Ethiopic' one of his four primary divisions of humanity, openly ranking it the lowest and the 'Caucasic' the "
        "highest. Deniker (1900), who sorted races first by hair form and then by skin colour, nose and stature, divided "
        "the region among a 'Negro' race (with 'Nigritian' and 'Bantu' sub-races), a short 'Negrillo' sub-race, a "
        "'Bushman' race and an 'Ethiopian' race of north-east Africa. Bettany's map (1888) drew similar borders between "
        "'Hamites', 'Ethiopians', 'Negroes', 'Bantu' and others.",
        [("Meyers b1 s0148d.jpg", "'Afrikanische Völker'",
          "Gustav Mützel, plate 'Afrikanische Völker' (African peoples), Meyers Konversations-Lexikon, 4th edition, "
          "vol. 1 (1885–90): 30 numbered portraits labelled by people, from Moroccan Arabs and Copts to Zulu, Akka and "
          "Somali.", MEYERS),
         ("Distribution of African Races (The World's Inhabitants, 1888, Ch. XI, p. 685).png", "Bettany's map of Africa",
          "G. T. Bettany, The World's Inhabitants (1888), ch. XI 'Distribution of African Races', p. 685: map with its "
          "own labels 'Hamites', 'Ethiopians', 'Fulbs', 'Negroes', 'Bantu', 'Hottentots' and 'Hovas'.",
          ("G. T. Bettany", "1888")),
         ("Shilluk man of classic Nilotic type, from Augustus Henry Keane's Man, Past and Present (1899).jpg", "'Shilluk, Nilote'",
          "Keane, Man, Past and Present, revised edition (1920), plate XIII, 6: 'Shilluk, Egyptian Sudan (Nilote)'.", KEANE20)]),
    "s_asia": ("South Asia",
        "Herbert Risley's The People of India (1908) sorted the population of British India into seven 'types', among them "
        "'Turko-Iranian', 'Indo-Aryan', 'Dravidian' and 'Mongoloid', by head shape, stature, complexion and especially the "
        "nasal index (nose breadth as a percentage of nose height). Risley claimed that the castes he measured in "
        "Hindustan and Bihar fell in much the same order by nasal index as by social precedence. Deniker (1900) described "
        "an 'Indo-Afghan race' among Afghans, Rajputs and Brahmins and a 'Dravidian race' in the south, while the Meyers "
        "map (1885–90) left 'Dravidians and Sinhalese' in an uncertain position.",
        [("The races of man, figure 125 Gurkha of the Kus or Khas tribe (IA deniofmanoutlinraces00rich).png", "Gurkha, fig. 125",
          "Deniker, The Races of Man (1900), fig. 125: 'Gurkha of the Kus or Khas tribe, Nepal; mixed Indo-Thibetan type'.", DENIKER),
         ("Afghan man of classic Iranid type, from Augustus Henry Keane's Man, Past and Present (1899).jpg", "'Afghan, Iranian'",
          "Keane, Man, Past and Present, revised edition (1920), plate XII, 6: 'Afghan of Zerafshan (Iranian)'.", KEANE20)]),
    "c_asia": ("Central Asia",
        "Deniker (1900) described a 'Turkish' or 'Turco-Tatar' race that he called fairly pure among the Kirghiz and the "
        "Tatars of Astrakhan and mixed with other races among Turkmen and Ottoman Turks. Ripley (1899), drawing on "
        "measurements by Ujfalvy and Topinard, claimed that the mountain Tajiks (Galchas) of the Pamir, grey-eyed, "
        "dark-haired, stocky and with cephalic indexes mostly above 86, matched his European 'Alpine' type almost exactly, "
        "and took this as a sign that round-headed Europeans came from Asia. Keane's book (1920 edition) still labelled "
        "Tajiks 'Alpine'.",
        [("Tajik man of classic Alpine type, from Augustus Henry Keane's Man, Past and Present (1899).jpg", "'Tajik, Alpine'",
          "Keane, Man, Past and Present, revised edition (1920), plate XIV, 5: 'Tajik woman of E. Turkestan (Alpine)'.", KEANE20),
         ("The Races of Man, figure 107 Kundrof Tatar (Turkoman) of Astrakhan (IA deniofmanoutlinraces00rich).png", "Kundrof Tatar, fig. 107",
          "Deniker, The Races of Man (1900), fig. 107: 'Kundrof Tatar (Turkoman) of Astrakhan, with cap', one of his "
          "examples of the Turkish race.", DENIKER)]),
    "e_asia": ("East Asia",
        "Blumenbach (1795) grouped the peoples of East and North Asia as the 'Mongolian' variety, one of his five, and "
        "illustrated it with a skull labelled 'Tungusae' (a Tungus). Deniker (1900) split his 'Mongol race' into a northern "
        "sub-race with oval or round faces and prominent cheekbones (Manchuria, Korea, northern China, Mongolia) and a "
        "southern one with lozenge-shaped or square faces (southern China and Indo-China), and treated the Ainu of "
        "northern Japan as a race of their own.",
        [("Blumenbach's five races.JPG", "Blumenbach's five skulls",
          "Johann Friedrich Blumenbach, De generis humani varietate nativa, 3rd edition (1795), plate II: skulls labelled "
          "Tungusae, Caribaei, Feminae Georgianae, O-taheitae and Aethiopissae, which stood for his Mongolian, American, "
          "Caucasian, Malay and Ethiopian varieties.", BLUMENBACH),
         ("The races of man, figure 119 Leao-yu-chow (IA deniofmanoutlinraces00rich).png", "Leao-yu-chow, fig. 119",
          "Deniker, The Races of Man (1900), fig. 119: 'Leao-yu-chow, Chinese woman, born at Foo-chow, eighteen years old, "
          "height 1m. 52', cited for his southern Mongol sub-race.", DENIKER)]),
    "se_asia": ("Southeast Asia",
        "Blumenbach (1795) created a fifth, 'Malay' variety for the peoples of the Malay world and the Pacific islands. "
        "Deniker (1900) placed northern Vietnam in his southern 'Mongol' sub-race and described an 'Indonesian race' among "
        "Dayaks, Bataks and others in the archipelago, while both he and Keane set apart the Semang, the Aeta and the "
        "Andaman islanders as 'Negritos', a group defined mainly by short stature and tightly curled ('woolly') hair.",
        [("The races of man, figure 121 Tong King artisan.png", "Tong King artisan, fig. 121",
          "Deniker, The Races of Man (1900), fig. 121: 'Tong King artisan of Son-tai, twenty-three years old', cited for "
          "his southern Mongol sub-race.", DENIKER),
         ("Semang man of classic Negrito type, from Augustus Henry Keane's Man, Past and Present (1899).jpg", "'Semang, Negrito'",
          "Keane, Man, Past and Present, revised edition (1920), plate II, 2: 'Semang, Malay Peninsula (Negrito)'.", KEANE20)]),
    "oceania": ("Oceania",
        "Huxley (1870) grouped Aboriginal Australians under an 'Australioid' type, and the Meyers plate of Oceanic peoples "
        "(1885–90) arranged its portraits under the headings Australians, Melanesians, Micronesians and Polynesians. "
        "Deniker (1900) separated an 'Australian' race, a 'Melanesian' race with a 'Papuan' sub-race in New Guinea, which "
        "he told apart from African groups by less tightly curled hair and lighter skin, and a 'Polynesian' race found "
        "from Hawaii to New Zealand.",
        [("Meyers b12 s0584a.jpg", "'Ozeanische Völker'",
          "Plate 'Ozeanische Völker' (Oceanic peoples), Meyers Konversations-Lexikon, 4th edition, vol. 12 (1885–90): "
          "30 numbered portraits grouped as Australier, Melanesier, Mikronesier and Polynesier. The face of no. 1 is "
          "torn in this scan.", MEYERS_PUB),
         ("Kiwai man of classic Papuan type, from Augustus Henry Keane's Man, Past and Present (1899).jpg", "'Kiwai, Papuan'",
          "Keane, Man, Past and Present, revised edition (1920), plate III, 4: 'Native of Oromosapua, Kiwai, British New "
          "Guinea (Papuan)'.", KEANE20)]),
    "americas": ("The Americas",
        "For the Americas these schemes described the Indigenous peoples; people of European, African or Asian descent "
        "were counted under their ancestors' 'races'. Blumenbach (1795) made Indigenous Americans the 'American' variety, "
        "and Samuel Morton's Crania Americana (1839) measured skull volume, concluded that all American nations except the "
        "'Polar tribes' formed one race, and attached claims about mental character to it. Deniker (1900) instead listed "
        "four races, North American, Central American, South American and Patagonian, separated by stature, head shape "
        "and hair, while the Meyers map (1885–90) put 'Americans' inside its 'Mongolian race'.",
        [("Meyers b1 s0457e.jpg", "'Amerikanische Völker'",
          "Gustav Mützel, plate 'Amerikanische Völker' (American peoples), Meyers Konversations-Lexikon, 4th edition, "
          "vol. 1 (1885–90): 33 numbered portraits from the Aleuts and Inuit to the Mapuche and Fuegians.", MEYERS),
         ("The races of man, figure 167 Kalina or Carib of Dutch Guiana.png", "Kalina (Carib), fig. 167",
          "Deniker, The Races of Man (1900), fig. 167: 'Kalina or Carib of Dutch Guiana', cited for the straight-haired "
          "sub-race of his South American race.", DENIKER)]),
}

# UN subregions as used in data/countries.json. Iran goes with the Middle East, as the classifiers treated it.
SUBREGION = {
    "Northern Europe": "nw_europe", "Western Europe": "nw_europe",
    "Central Europe": "ce_europe", "Eastern Europe": "ce_europe",
    "Southern Europe": "s_europe", "Southeast Europe": "s_europe",
    "Western Asia": "mena", "Northern Africa": "mena",
    "Eastern Africa": "ssa", "Middle Africa": "ssa", "Southern Africa": "ssa", "Western Africa": "ssa",
    "Southern Asia": "s_asia", "Central Asia": "c_asia", "Eastern Asia": "e_asia", "South-Eastern Asia": "se_asia",
    "Australia and New Zealand": "oceania", "Melanesia": "oceania", "Micronesia": "oceania", "Polynesia": "oceania",
    "Caribbean": "americas", "Central America": "americas", "North America": "americas", "South America": "americas",
}
# Switzerland and Liechtenstein were the core of Ripley's 'Alpine' type and Deniker's Western race (ce_europe);
# Monaco lies on the coast Deniker gave to his 'Littoral' race (s_europe).
OVERRIDE = {"IRN": "mena", "CHE": "ce_europe", "LIE": "ce_europe", "MCO": "s_europe"}
# Left out: no permanent resident population today. The Chagossians of IOT were removed by Britain in 1967-73.
# Islands first settled by Europeans and the people they brought (FLK, SHN, MUS, CPV ...) keep their region's text.
UNPEOPLED = {"ATA", "ATF", "HMD", "SGS", "IOT"}
NOT_PD = re.compile(r"PD-user|PD-self|Self-published|CC-BY|GFDL", re.I)
# An image title is shown as caption and accessible name, so a race label in it must be quoted as the source's words.
LABEL = re.compile(r"rac|rass|type|mongol|nord|alpin|teuton|iber|hamit|nilot|negr|papua|iran|caucas|ethiop|malay|semit|arya", re.I)


def get(params, tries=5):
    url = API + urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                raise
            # Wikimedia rate-limits bursts (429): wait as long as it asks, or longer each time.
            wait = getattr(e, "headers", None) and e.headers.get("Retry-After")
            time.sleep(int(wait) if wait and wait.isdigit() else 10 * (i + 1))


def commons(files):
    """Image info and categories for File: pages, keyed by the name as written in REGIONS."""
    titles = ["File:" + f for f in files]
    params = {"action": "query", "titles": "|".join(titles), "prop": "imageinfo|categories",
              "iiprop": "url|size|extmetadata", "iiurlwidth": "500", "cllimit": "max"}  # panel tiles; the lightbox asks for 1280
    pages, cont, alias = {}, {}, {}
    while True:
        d = get({**params, **cont})
        alias.update({n["to"]: n["from"] for n in d["query"].get("normalized", [])})
        for p in d["query"]["pages"]:
            rec = pages.setdefault(p["title"], {"cats": []})
            rec["cats"] += [c["title"] for c in p.get("categories", [])]
            if "imageinfo" in p:
                rec["ii"] = p["imageinfo"][0]
            if p.get("missing"):
                rec["missing"] = True
        if "continue" not in d:
            break
        cont = d["continue"]
        time.sleep(1)
    return {alias.get(t, t)[5:]: rec for t, rec in pages.items()}


def main():
    countries = json.loads((ROOT / "data" / "countries.json").read_text(encoding="utf-8"))["countries"]
    files = [img[0] for _, _, imgs in REGIONS.values() for img in imgs]
    info = {}
    for i in range(0, len(files), 25):
        info.update(commons(files[i:i + 25]))
        time.sleep(2)

    regions, titles = {}, {}
    for key, (title, text, imgs) in REGIONS.items():
        assert 2 <= len(re.findall(r"[.!?](?:\s|$)", text)) <= 4, (key, "text should be 2-4 sentences")
        out = []
        for name, short, caption, (author, year) in imgs:
            assert short.startswith("'") or not LABEL.search(short), (short, "quote race labels in titles")
            assert titles.setdefault(short, name) == name, (short, "one title, one image")
            rec = info[name]
            assert not rec.get("missing") and "ii" in rec, ("missing on Commons", name)
            ii, meta = rec["ii"], rec["ii"].get("extmetadata", {})
            licence = meta.get("LicenseShortName", {}).get("value", "")
            # Only public-domain originals: a CC licence or a self-made redraw is refused.
            assert licence == "Public domain", (name, licence)
            assert not any(NOT_PD.search(c) for c in rec["cats"]), (name, [c for c in rec["cats"] if NOT_PD.search(c)])
            # Commons may round the request to a standard thumbnail size or return a small original as is,
            # while reporting the requested width either way, so the real size is read from the URL.
            url = (ii.get("thumburl") or ii["url"]).split("?")[0]  # drop Commons' utm_ tracking query
            px = re.search(r"/(\d+)px-[^/]+$", url)
            w = int(px.group(1)) if px else ii["width"]
            out.append({"title": short, "caption": caption, "img": url, "page": ii["descriptionurl"].split("?")[0],
                        "author": author, "year": year, "licence": licence,
                        "w": w, "h": round(ii["height"] * w / ii["width"])})
        assert 1 <= len(out) <= 3, key
        regions[key] = {"title": title, "text": text, "images": out}

    mapping = {}
    for c in countries.values():
        iso = c.get("iso3")
        if not iso or iso in UNPEOPLED:
            continue
        mapping[iso] = OVERRIDE.get(iso) or SUBREGION[c["region"]]  # KeyError on a new subregion is intended

    # Self-checks: a broken join or a source change shows up here.
    assert set(mapping.values()) == set(regions), set(regions) ^ set(mapping.values())
    assert len(mapping) >= 225, len(mapping)
    assert mapping["VNM"] == "se_asia" and mapping["DEU"] == "nw_europe" and mapping["IRN"] == "mena"
    assert mapping["POL"] == "ce_europe" and mapping["BRA"] == "americas" and mapping["FJI"] == "oceania"
    assert mapping["CHE"] == "ce_europe" and mapping["MCO"] == "s_europe" and mapping["GEO"] == "mena"
    assert 3 <= len(re.findall(r"[.!?](?:\s|$)", NOTE)) <= 6

    data = {"built": datetime.date.today().isoformat(), "note": NOTE,
            "sources": [{"title": t, "author": a, "year": y, "url": u} for t, a, y, u in SOURCES],
            "regions": regions, "countries": dict(sorted(mapping.items()))}
    path = ROOT / "data" / "people" / "history.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path} ({len(regions)} regions, {sum(len(r['images']) for r in regions.values())} images, "
          f"{len(mapping)} countries)")


if __name__ == "__main__":
    main()

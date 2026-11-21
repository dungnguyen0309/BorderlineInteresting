"""Builds data/maps/income/adm1.topo.json for the Income map type.

Source: Kummu, Kosonen and Masoumzadeh Sayyar, gridded GDP per capita PPP 1990-2024
(Zenodo record 18429133, CC BY 4.0, https://doi.org/10.5281/zenodo.18429133).
The admin-1 GeoPackage is a SQLite file, so it is read with sqlite3; shapely simplifies the
polygons as one coverage (shared edges stay shared, so no slivers open between regions).

Run from the hinterland folder:  python -I scripts/build_income.py [cache folder]
The three source files (about 13 MB) are downloaded once into the cache folder.
"""
import csv
import json
import os
import sqlite3
import sys
import tempfile
import time
import urllib.request

import shapely

RECORD = 'https://zenodo.org/api/records/18429133/files/{}/content'
FILES = ['polyg_adm1_gdp_perCapita_1990_2024.gpkg', 'tabulated_adm0_gdp_perCapita.csv', 'adm1_metaData.csv']
UA = 'Borderline-Interesting-research-map/1.0 (static site build script)'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'maps', 'income', 'adm1.topo.json')
YEARS = ('1990', '2024')
TOLERANCE = 0.03  # degrees; about 3 km, below a pixel at regional zoom
Q = 100000  # quantisation steps across the world (about 400 m)


# 151 region names in the source lost a letter to U+FFFD (written # here); these are the official spellings.
NAME_FIXES = dict(line.split('=') for line in """
Au#erfern=Außerfern|M#hlviertel=Mühlviertel|Nieder#sterreich-S#d=Niederösterreich-Süd|Oberk#rnten=Oberkärnten
Sankt P#lten=Sankt Pölten|S#dburgenland=Südburgenland|Unterk#rnten=Unterkärnten|West- und S#dsteiermark=West- und Südsteiermark
Wiener Umland/S#dteil=Wiener Umland/Südteil|#stliche Obersteiermark=Östliche Obersteiermark
Alt#tting=Altötting|Bad D#rkheim=Bad Dürkheim|Bad T#lz-Wolfratshausen=Bad Tölz-Wolfratshausen|Bergstra#e=Bergstraße
B#blingen=Böblingen|B#rde=Börde|Dessau-Ro#lau, Kreisfreie Stadt=Dessau-Roßlau, Kreisfreie Stadt|D#ren=Düren
D#sseldorf, Kreisfreie Stadt=Düsseldorf, Kreisfreie Stadt|Eichst#tt=Eichstätt|Eifelkreis Bitburg-Pr#m=Eifelkreis Bitburg-Prüm
Erlangen-H#chstadt=Erlangen-Höchstadt|F#rstenfeldbruck=Fürstenfeldbruck|F#rth, Kreisfreie Stadt=Fürth, Kreisfreie Stadt
F#rth, Landkreis=Fürth, Landkreis|Gie#en, Landkreis=Gießen, Landkreis|Gro#-Gerau=Groß-Gerau|G#nzburg=Günzburg
G#ppingen=Göppingen|G#rlitz=Görlitz|G#tersloh=Gütersloh|G#ttingen=Göttingen|Ha#berge=Haßberge|H#xter=Höxter
Kempten (Allg#u), Kreisfreie Stadt=Kempten (Allgäu), Kreisfreie Stadt|Kyffh#userkreis=Kyffhäuserkreis
K#ln, Kreisfreie Stadt=Köln, Kreisfreie Stadt|L#beck, Kreisfreie Stadt=Lübeck, Kreisfreie Stadt|L#chow-Dannenberg=Lüchow-Dannenberg
L#neburg, Landkreis=Lüneburg, Landkreis|L#rrach=Lörrach|Mansfeld-S#dharz=Mansfeld-Südharz|Mei#en=Meißen
Minden-L#bbecke=Minden-Lübbecke|M#hldorf a. Inn=Mühldorf a. Inn|M#lheim an der Ruhr,Kreisfreie Stadt=Mülheim an der Ruhr, Kreisfreie Stadt
M#nchen, Kreisfreie Stadt=München, Kreisfreie Stadt|M#nchen, Landkreis=München, Landkreis
M#nchengladbach, Kreisfreie Stadt=Mönchengladbach, Kreisfreie Stadt|M#nster, Kreisfreie Stadt=Münster, Kreisfreie Stadt
M#rkisch-Oderland=Märkisch-Oderland|M#rkischer Kreis=Märkischer Kreis|Neum#nster, Kreisfreie Stadt=Neumünster, Kreisfreie Stadt
Neustadt an der Weinstra#e, Kreisfreie Stadt=Neustadt an der Weinstraße, Kreisfreie Stadt|N#rnberg, Kreisfreie Stadt=Nürnberg, Kreisfreie Stadt
N#rnberger Land=Nürnberger Land|Oberallg#u=Oberallgäu|Osnabr#ck, Kreisfreie Stadt=Osnabrück, Kreisfreie Stadt
Osnabr#ck, Landkreis=Osnabrück, Landkreis|Ostallg#u=Ostallgäu|Pl#n=Plön|Regionalverband Saarbr#cken=Regionalverband Saarbrücken
Rendsburg-Eckernf#rde=Rendsburg-Eckernförde|Rhein-Hunsr#ck-Kreis=Rhein-Hunsrück-Kreis|Rh#n-Grabfeld=Rhön-Grabfeld
Rotenburg (W#mme)=Rotenburg (Wümme)|Schw#bisch Hall=Schwäbisch Hall|Spree-Nei#e=Spree-Neiße|St#dteregion Aachen=Städteregion Aachen
S#chsische Schweiz-Osterzgebirge=Sächsische Schweiz-Osterzgebirge|S#dliche Weinstra#e=Südliche Weinstraße|S#dwestpfalz=Südwestpfalz
S#mmerda=Sömmerda|Teltow-Fl#ming=Teltow-Fläming|T#bingen, Landkreis=Tübingen, Landkreis|Unterallg#u=Unterallgäu
Vorpommern-R#gen=Vorpommern-Rügen|Wei#enburg-Gunzenhausen=Weißenburg-Gunzenhausen|Werra-Mei#ner-Kreis=Werra-Meißner-Kreis
Wolfenb#ttel=Wolfenbüttel|W#rzburg, Kreisfreie Stadt=Würzburg, Kreisfreie Stadt|W#rzburg, Landkreis=Würzburg, Landkreis
Zweibr#cken, Kreisfreie Stadt=Zweibrücken, Kreisfreie Stadt
Almer#a=Almería|Araba/#lava=Araba/Álava|Castell#n=Castellón|C#ceres=Cáceres|C#diz=Cádiz|Ja#n=Jaén|Le#n=León|L#rida=Lérida
M#laga=Málaga|#vila=Ávila
Ard#che=Ardèche|Ari#ge=Ariège|Bouches-du-Rh#ne=Bouches-du-Rhône|Corr#ze=Corrèze|C#te-d'Or=Côte-d'Or|C#tes-d'Armor=Côtes-d'Armor
Deux-S#vres=Deux-Sèvres|Dr#me=Drôme|Finist#re=Finistère|Haute-Sa#ne=Haute-Saône|Hautes-Pyr#n#es=Hautes-Pyrénées|H#rault=Hérault
Is#re=Isère|Loz#re=Lozère|Ni#vre=Nièvre|Puy-de-D#me=Puy-de-Dôme|Pyr#n#es-Atlantiques=Pyrénées-Atlantiques
Pyr#n#es-Orientales=Pyrénées-Orientales|Rh#ne=Rhône|Sa#ne-et-Loire=Saône-et-Loire|Vend#e=Vendée
Borsod-Aba#j-Zempl#n=Borsod-Abaúj-Zemplén|B#cs-Kiskun=Bács-Kiskun|B#k#s=Békés|Csongr#d=Csongrád|Fej#r=Fejér|Hajd#-Bihar=Hajdú-Bihar
J#sz-Nagykun-Szolnok=Jász-Nagykun-Szolnok|Kom#rom-Esztergom=Komárom-Esztergom|N#gr#d=Nógrád|Szabolcs-Szatm#r-Bereg=Szabolcs-Szatmár-Bereg
Veszpr#m=Veszprém|Paneve#ys county=Panevėžys county|Tel#iai county=Telšiai county|#iauliai county=Šiauliai county
City of L#dz=City of Łódź|Jeleniog#rski=Jeleniogórski|L#dzki=Łódzki|Zielonog#rski=Zielonogórski
Alto T#mega=Alto Tâmega|C#vado=Cávado|Lez#ria do Tejo=Lezíria do Tejo|M#dio Tejo=Médio Tejo|Regi#o de Aveiro=Região de Aveiro
Regi#o de Coimbra=Região de Coimbra|Regi#o de Leiria=Região de Leiria|Terras de Tr#s-os-Montes=Terras de Trás-os-Montes
T#mega e Sousa=Tâmega e Sousa|Viseu D#o Laf#es=Viseu Dão Lafões
Bing#l=Bingöl|D#zce=Düzce|G#m#shane=Gümüşhane|I#el=İçel|Karab#k=Karabük|K#tahya=Kütahya|#anakkale=Çanakkale|#ankiri=Çankırı|#orum=Çorum
""".replace('#', '�').replace('\n', '|').strip('|').split('|'))


def fetch(cache):
    os.makedirs(cache, exist_ok=True)
    for name in FILES:
        path = os.path.join(cache, name)
        if os.path.exists(path):
            continue
        print('downloading', name)
        req = urllib.request.Request(RECORD.format(name), headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=120) as r, open(path + '.part', 'wb') as f:
            f.write(r.read())
        os.replace(path + '.part', path)
        time.sleep(2)  # Zenodo rate-limits per IP
    return [os.path.join(cache, n) for n in FILES]


def gpkg_geom(blob):
    # GeoPackage binary: 'GP', version, flags, srs id, optional envelope, then WKB.
    assert blob[:2] == b'GP', 'not a GeoPackage geometry'
    env = (blob[3] >> 1) & 7
    return shapely.from_wkb(blob[8 + [0, 32, 48, 48, 64][env]:])


def num(v):
    return None if v in (None, '', 'NA') else round(float(v))


def main():
    cache = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), 'hinterland-income-src')
    gpkg, adm0, meta = fetch(cache)

    db = sqlite3.connect(gpkg)
    table = db.execute("select table_name from gpkg_contents where data_type = 'features'").fetchone()[0]
    rows = db.execute(f'select geom, iso3, Country, Subnat, "{YEARS[0]}", "{YEARS[1]}" from "{table}"').fetchall()
    geoms = shapely.make_valid(shapely.coverage_simplify([gpkg_geom(r[0]) for r in rows], TOLERANCE))

    x0, y0, x1, y1 = -180.0, -90.0, 180.0, 90.0
    kx, ky = (x1 - x0) / (Q - 1), (y1 - y0) / (Q - 1)
    arcs, out = [], []
    for r, g in zip(rows, geoms):
        polys = []
        # Twice: make_valid can return a collection that holds a multipolygon (and stray lines or points).
        for part in shapely.get_parts(shapely.get_parts(g)):
            if part.geom_type != 'Polygon':
                continue
            rings = []
            for ring in [part.exterior, *part.interiors]:
                pts, last = [], None
                for x, y in ring.coords:
                    q = (round((x - x0) / kx), round((y - y0) / ky))
                    if q != last:
                        pts.append(q)
                        last = q
                if len(pts) < 4:
                    continue
                arc, px, py = [], 0, 0
                for qx, qy in pts:
                    arc.append([qx - px, qy - py])
                    px, py = qx, qy
                rings.append([len(arcs)])
                arcs.append(arc)
            if rings:
                polys.append(rings)
        if not polys:
            continue
        out.append({'type': 'MultiPolygon', 'arcs': polys, 'properties': {
            'n': NAME_FIXES.get(r[3], r[3]) or r[2], 'c': r[1], 'sub': 1 if r[3] else 0, 'v': num(r[5]), 'a': num(r[4])}})

    nations = {}
    for r in csv.DictReader(open(adm0, encoding='utf-8-sig')):
        nations[r['iso3']] = {'n': r['Country'], 'v': num(r[YEARS[1]]), 'a': num(r[YEARS[0]])}
    for r in csv.DictReader(open(meta, encoding='utf-8-sig', errors='replace')):
        if r['iso3'] in nations and r['YearRanges'] not in ('', 'NA'):
            nations[r['iso3']]['rep'] = r['YearRanges']

    topo = {
        'type': 'Topology',
        'transform': {'scale': [kx, ky], 'translate': [x0, y0]},
        'objects': {'adm1': {'type': 'GeometryCollection', 'geometries': out}},
        'arcs': arcs,
        'years': [int(y) for y in YEARS],
        'nations': nations,
        'source': 'Kummu, Kosonen and Masoumzadeh Sayyar, Zenodo 18429133 (CC BY 4.0), simplified',
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(topo, f, separators=(',', ':'), ensure_ascii=False)

    size = os.path.getsize(OUT)
    # Self-checks: every region kept, values present, the file stays lean.
    assert len(out) >= len(rows) - 5, (len(out), len(rows))
    assert all(g['properties']['v'] and g['properties']['v'] > 0 for g in out)
    assert all(g['properties']['c'] in nations for g in out)
    assert size < 3_000_000, size
    assert '�' not in json.dumps(out, ensure_ascii=False), 'a region name is still broken'
    print(f'{len(out)} regions of {len(rows)}, {len(nations)} countries, {sum(map(len, arcs))} points, {size:,} bytes -> {OUT}')


if __name__ == '__main__':
    main()

# Borderline Interesting

Live at https://borderlineinteresting.vercel.app

An interactive globe for geopolitics: sea chokepoints, conflicts, territorial disputes, contested areas, strategic lines, military bases and ports. Every country has a profile in eight tabs: overview (with names, codes, capitals, currency and languages), people (population since 1976 and an age pyramid), economy (GDP since 1976, sector and electricity mixes), institutions and leaders, security (military spending since 1990, armed forces, arms trade, nuclear status, alliances, bases and hot spots), religion, first-level divisions, and geography (with the antipode). Any data colouring can be opened as a ranked list, and every rank in a profile links to it.

Other tools:

- Search with Ctrl K (⌘K on a Mac) finds countries by name, former name (Swaziland, Burma, Persia), ISO code or a typo of either.
- Map types besides the Atlas: plain borders, roads, airports, time zones, postal codes, regional GDP, resources, flags, physical, photographic, topographic and bathymetric relief, geology, plate tectonics, earthquakes, volcanic hazard, weather, plant hardiness and species. On the Airports map a click opens an airport's facts, a Sentinel-2 view from above, its Commons photos and the start of its Wikipedia article, and search also finds airports by name or IATA code.
- The Countries filter switches the map, lists and search between all territories and UN members only. Tuvalu, one of the 193 members, has no shape at 1:50m.
- Compare puts two countries side by side, with both trends on shared axes.
- True size pins a country's outline to the middle of the view, so turning the globe slides it over other places at its real size, and shows how much a Mercator map would inflate it.

It is a static site (HTML, CSS and JavaScript modules) with no build step. d3 and topojson-client load from jsDelivr.

## Run locally

```bash
python scripts/serve.py
```

Then open http://localhost:8765. `serve.py` serves the folder without caching; any static server works too (`python -m http.server 8765`). Links like `#VNM` (a country's ISO code), `#hormuz` (a place id) or `#compare-DEU-JPN` open that item directly; `?colour=pop` sets the map colouring and `?countries=un` the UN filter.

## Update the data

```bash
python scripts/build_data.py
```

This rebuilds `data/countries.json` from the World Bank API and mledoze/countries and checks that every country code in `data/hotspots.json` and `data/blocs.json` exists. Place notes and group memberships in those two files are edited by hand; each place note carries an `asOf` month and one to three `sources` (title, publisher, URL), listed by place in the Sources section. Sovereignty tiers (UN observer, partly recognised, special status), former names, multiple capitals and driving side come from `scripts/patches.json`, also edited by hand.

```bash
python scripts/build_atlas.py
```

Run after `build_data.py`. This writes `data/atlas.json` (names and codes, currencies, languages, population and GDP since 1976, age pyramids, sector and electricity mixes, military spending, armed forces and arms transfers since 1990, and other latest World Bank figures). The app loads it the first time a profile opens.

```bash
python scripts/build_profiles.py
```

This rebuilds `data/profiles.json` (overview, institutions, religion, divisions). Leaders and government type come from each country's Wikipedia infobox, which is updated faster than Wikidata; Wikidata fills the gaps and supplies first-level divisions. Overviews are cached between runs. It makes a few hundred requests and takes several minutes.

```bash
python scripts/build_profiles.py --reparse
```

This re-derives the religion shares from the Factbook sentences already in `data/profiles.json`, with no network requests. Use it after changing the parser. A country gets bars only when its shares add up to 85–110%; otherwise the app prints the Factbook sentence.

```bash
python scripts/build_security.py
```

This writes `data/security.json` for the Security tab: each country's Military and Security text from the CIA World Factbook (forces, personnel, equipment, service age and obligation, deployments) and NPT parties. The nuclear lists (warheads, hosts, sharing, NPT and TPNW status) and their sources are edited by hand in the same file; mutual-defence and security-cooperation groups are marked by a `security` field in `data/blocs.json`, and each military base in `data/hotspots.json` names its `host` and `operator`. It makes one Wikidata query and a few hundred Factbook fetches, about a minute.

```bash
python scripts/build_military_photos.py
```

Run after `build_data.py`. This writes `data/security-photos.json` for the Security tab: up to six photos of each country's armed forces and their branches, and up to twelve of aircraft, ships, vehicles and missiles in their service. Wikidata names the subjects (operated by the country or its forces with no end date, types from 1960 on), the operator lists in each English Wikipedia article confirm the country still uses them, and Wikimedia Commons gives each file's licence, author and image. Only freely licensed photographs are kept.

```bash
python scripts/build_symbols.py
```

Run after `build_data.py`. This writes `data/symbols.json`, each country's flag and coat of arms (or emblem, or seal) for the head of Overview: Wikidata names the files and Wikimedia Commons gives each one's licence, author and image. Only freely licensed files are kept.

```bash
python scripts/build_airports.py
```

This writes `data/maps/airports/` for the Airports map: `markers.json` (every open airport with an IATA code, from OurAirports, with its class and yearly passengers) and `details/X.json` (each airport's facts by the first letter of its code, loaded on a click): runways from OurAirports, and opening date, operator, passengers, airline hubs, Commons category and Wikipedia article from Wikidata. Standard library only; it takes about five minutes.

```bash
python scripts/build_labels.py
```

This writes `data/labels.json`, where each country's name goes on the globe: the point of its largest polygon farthest from the outline, so a name sits on its own land. Run it again when the map file (`MAP_URL` in `app.js`) changes; a file built for another map is ignored and names go on centroids. Needs shapely.

## Sources

- Borders and coastlines: Natural Earth 1:50m via world-atlas (public domain)
- Country figures: World Bank, World Development Indicators (CC BY 4.0)
- Codes, capitals and landlocked status: mledoze/countries (ODbL) and the World Bank
- Overviews, leaders and government type: Wikipedia (CC BY-SA 4.0)
- First-level divisions and fallback institutions: Wikidata (CC0)
- Religion shares: CIA World Factbook via factbook/factbook.json (public domain); each estimate's year is shown
- Security: World Bank military indicators (from SIPRI and IISS), the Factbook's Military and Security section, SIPRI and FAS nuclear forces, the UN Treaty Collection (TPNW), the Arms Control Association (NPT) and the alliance treaties and statements, listed in full in the app's Sources section
- Photographic map: NASA Blue Marble Next Generation (2004), VIIRS Black Marble (2016) and daily VIIRS NOAA-20 / MODIS Terra corrected reflectance, all through NASA GIBS ("We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."), and Sentinel-2 cloudless 2025 by EOX (CC BY-NC-SA 4.0, non-commercial use only)
- Airports map: OurAirports (public domain), Wikidata (CC0), photos from Wikimedia Commons (each under its own licence, shown when opened), summaries from Wikipedia (CC BY-SA 4.0) and views from above from Sentinel-2 cloudless 2025 by EOX (CC BY-NC-SA 4.0)
- Flags and coats of arms: Wikimedia Commons via Wikidata (P41, P94); each image shows its author and licence when opened
- Armed forces and equipment photos: Wikimedia Commons via Wikidata (CC0, operators from P137), checked against English Wikipedia operator lists (CC BY-SA); each photo shows its author and licence when opened
- The app's Sources section lists every source in one place: each map type's full credit (`credit` in `maps/types.js` and `maps/types/`), each hot spot's sources by place, and the books behind the historical view. The bottom corner of the map shows only the credit a licence requires on the map itself (`onMap`), such as OpenStreetMap's

Author: Tuan Dung Nguyen

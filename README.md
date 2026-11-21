# Borderline Interesting

Live at https://borderlineinteresting.vercel.app

An interactive globe for geopolitics: sea chokepoints, conflicts, territorial disputes, contested areas, strategic lines, military bases and ports. Every country has a profile in seven tabs: overview (with names, codes, capitals, currency and languages), people (population since 1976 and an age pyramid), economy (GDP since 1976, sector and electricity mixes), institutions and leaders, religion, first-level divisions, and geography (with the antipode). Any data colouring can be opened as a ranked list, and every rank in a profile links to it.

Other tools:

- Search with Ctrl K (⌘K on a Mac) finds countries by name, former name (Swaziland, Burma, Persia), ISO code or a typo of either.
- The Countries filter switches the map, lists and search between all territories and UN members only. Tuvalu, one of the 193 members, has no shape at 1:50m.
- Compare puts two countries side by side, with both trends on shared axes.
- True size pins a country's outline to the middle of the view, so turning the globe slides it over other places at its real size, and shows how much a Mercator map would inflate it.

It is a static site (HTML, CSS and JavaScript modules) with no build step. d3 and topojson-client load from jsDelivr. On Vercel, `api/live.py` relays the live flight data (see below) and `vercel.json` routes `/live/flights/...` to it.

## Run locally

```bash
python scripts/serve.py
```

Then open http://localhost:8765. `serve.py` serves the folder without caching and relays live flight data: adsb.fi and adsb.lol send no CORS header, so a page cannot read them directly. It forwards only three routes (aircraft within 250 nautical miles of a point, military aircraft, emergency squawks), keeps each answer for 10 seconds and sends at most one request a second upstream. Any static server works for everything else (`python -m http.server 8765`); the Flights map then says that live data needs `serve.py`. On Vercel, `api/live.py` imports the same allowlist and feeds from `serve.py`, and the CDN keeps each answer for 10 seconds. Links like `#VNM` (a country's ISO code), `#hormuz` (a place id) or `#compare-DEU-JPN` open that item directly; `?colour=pop` sets the map colouring and `?countries=un` the UN filter.

## Update the data

```bash
python scripts/build_data.py
```

This rebuilds `data/countries.json` from the World Bank API and mledoze/countries and checks that every country code in `data/hotspots.json` and `data/blocs.json` exists. Place notes and group memberships in those two files are edited by hand; each place note carries an `asOf` month and one to three `sources` (title, publisher, URL), listed by place in the Sources section. Sovereignty tiers (UN observer, partly recognised, special status), former names, multiple capitals and driving side come from `scripts/patches.json`, also edited by hand.

```bash
python scripts/build_atlas.py
```

Run after `build_data.py`. This writes `data/atlas.json` (names and codes, currencies, languages, population and GDP since 1976, age pyramids, sector and electricity mixes, and other latest World Bank figures). The app loads it the first time a profile opens.

```bash
python scripts/build_profiles.py
```

This rebuilds `data/profiles.json` (overview, institutions, religion, divisions). Leaders and government type come from each country's Wikipedia infobox, which is updated faster than Wikidata; Wikidata fills the gaps and supplies first-level divisions. Overviews are cached between runs. It makes a few hundred requests and takes several minutes.

```bash
python scripts/build_profiles.py --reparse
```

This re-derives the religion shares from the Factbook sentences already in `data/profiles.json`, with no network requests. Use it after changing the parser. A country gets bars only when its shares add up to 85–110%; otherwise the app prints the Factbook sentence.

```bash
python scripts/build_symbols.py
```

Run after `build_data.py`. This writes `data/symbols.json`, each country's flag and coat of arms (or emblem, or seal) for the head of Overview: Wikidata names the files and Wikimedia Commons gives each one's licence, author and image. Only freely licensed files are kept.

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
- Live flights: adsb.fi open data (personal, non-commercial use) with adsb.lol as fallback (ODbL 1.0), read through `scripts/serve.py`
- Live ships: Fintraffic Digitraffic (CC BY 4.0) and Kystverket (NLOD 1.0; its real-time address is the undocumented one its own map uses, so it is read only when the site runs on localhost, until Kystverket agrees to its use on the public site). Shipping density: IMF / World Bank Global Shipping Traffic Density, 2015 to February 2021 (CC BY 4.0), built by `python scripts/build_maritime.py` (downloads 535 MB once to the temp folder)
- Photographic map: NASA Blue Marble Next Generation (2004), VIIRS Black Marble (2016) and daily VIIRS NOAA-20 / MODIS Terra corrected reflectance, all through NASA GIBS ("We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."), and Sentinel-2 cloudless 2025 by EOX (CC BY-NC-SA 4.0, non-commercial use only)
- Flags and coats of arms: Wikimedia Commons via Wikidata (P41, P94); each image shows its author and licence when opened
- The app's Sources section lists every source in one place: each map type's full credit (`credit` in `maps/types.js` and `maps/types/`), each hot spot's sources by place, and the books behind the historical view. The bottom corner of the map shows only the credit a licence requires on the map itself (`onMap`), such as OpenStreetMap's

Author: Tuan Dung Nguyen

"""Serves Borderline Interesting on this computer, with a small proxy for live flight data.

    python scripts/serve.py            # http://127.0.0.1:8765
    python scripts/serve.py 9000

Why a proxy: the open ADS-B feeds (adsb.fi, adsb.lol) answer requests but send no CORS header, so a page
cannot read them directly. This server fetches them for the page, from an allowlist of paths only, caches
each answer for 10 seconds and sends at most one request a second upstream (adsb.fi's limit). Everything
else is served from this folder as static files, without caching, so edits show on the next reload.

Routes (all return JSON with "ac": [...], "source" and "fetched"):
    /live/flights/point/<lat>/<lon>/<nm>   aircraft within nm nautical miles (max 250) of a point
    /live/flights/mil                     military aircraft worldwide
    /live/flights/sqk/<7500|7600|7700>     aircraft squawking an emergency code
On a static host (no proxy) these return 404 and the Flights map says live data needs this server.
"""
import functools
import http.server
import json
import pathlib
import re
import sys
import threading
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Borderline-Interesting-research-map/1.0 (non-commercial research map)"}
TTL = 10          # seconds an answer is reused
SPACING = 1.0     # seconds between upstream requests
_cache, _lock, _last = {}, threading.Lock(), [0.0]


def upstreams(path):
    """The upstream URLs for an allowed route, first choice first, or None."""
    m = re.fullmatch(r"/live/flights/point/(-?\d{1,2}(?:\.\d+)?)/(-?\d{1,3}(?:\.\d+)?)/(\d{1,3})", path)
    if m:
        lat, lon, nm = float(m[1]), float(m[2]), int(m[3])
        if abs(lat) > 90 or abs(lon) > 180 or not 1 <= nm <= 250:
            return None
        return [f"https://opendata.adsb.fi/api/v3/lat/{lat:.4f}/lon/{lon:.4f}/dist/{nm}",
                f"https://api.adsb.lol/v2/point/{lat:.4f}/{lon:.4f}/{nm}"]
    if path == "/live/flights/mil":
        return ["https://opendata.adsb.fi/api/v2/mil", "https://api.adsb.lol/v2/mil"]
    m = re.fullmatch(r"/live/flights/sqk/(7500|7600|7700)", path)
    if m:
        return [f"https://opendata.adsb.fi/api/v2/sqk/{m[1]}", f"https://api.adsb.lol/v2/sqk/{m[1]}"]
    return None


def fetch(urls):
    """First upstream that answers, normalised to {"ac": [...], "source", "fetched"}; cached for TTL seconds."""
    key = urls[0]
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < TTL:
            return hit[1]
        errors = []
        for url in urls:
            wait = _last[0] + SPACING - time.time()
            if wait > 0:
                time.sleep(wait)
            _last[0] = time.time()
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
                    data = json.load(r)
                body = {"ac": data.get("ac") or data.get("aircraft") or [], "source": url.split("/")[2], "fetched": int(time.time())}
                _cache[key] = (time.time() + (0 if url == urls[0] else 50), body)
                if len(_cache) > 200:
                    _cache.pop(next(iter(_cache)))
                return body
            except Exception as e:  # try the next feed
                errors.append(f"{url.split('/')[2]}: {e}")
        if hit and time.time() - hit[0] < 300:  # both feeds down: an older answer is better than none, and it says how old it is
            return hit[1]
        raise RuntimeError("; ".join(errors))


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 256
    daemon_threads = True


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if not path.startswith("/live/"):
            return super().do_GET()
        urls = upstreams(path)
        if not urls:
            return self.reply(404, {"error": "Unknown live data route."})
        try:
            self.reply(200, fetch(urls))
        except Exception as e:
            self.reply(502, {"error": f"The live flight feeds did not answer ({e})."})

    def reply(self, code, obj):
        raw = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


# Self-checks for the allowlist.
assert upstreams("/live/flights/point/50/8/250")[0].endswith("/lat/50.0000/lon/8.0000/dist/250")
assert upstreams("/live/flights/point/50/8/900") is None
assert upstreams("/live/flights/sqk/1234") is None
assert upstreams("/live/../secret") is None

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = Server(("127.0.0.1", port), functools.partial(Handler, directory=str(ROOT)))
    print(f"Borderline Interesting on http://127.0.0.1:{port}/ (live flight proxy at /live/flights/...)")
    server.serve_forever()

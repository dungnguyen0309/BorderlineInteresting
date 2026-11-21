"""Vercel function: the live flight relay of scripts/serve.py on the public site.

vercel.json sends /live/flights/<route> here as ?p=<route>; the allowlist, the feeds, the fallback and the
per-instance cache are serve.py's own. The CDN keeps each answer for 10 seconds, so the feeds see about one request
per route every 10 seconds however many people have the map open.
"""
import json
import pathlib
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
from serve import fetch, upstreams  # noqa: E402


def answer(route):
    urls = upstreams("/live/flights/" + urllib.parse.unquote(route or "").strip("/"))
    if not urls:
        return 404, {"error": "Unknown live data route."}
    try:
        return 200, fetch(urls)
    except Exception as e:  # both feeds down and no recent answer
        return 502, {"error": f"The live flight feeds did not answer ({e})."}


assert answer("../secret")[0] == 404 and answer("point/50/8/900")[0] == 404


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        code, body = answer(query.get("p", [""])[0])
        raw = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, s-maxage=10, stale-while-revalidate=20" if code == 200 else "no-store")
        if code == 200:  # Vercel's edge reads this one for functions; browsers never see it
            self.send_header("Vercel-CDN-Cache-Control", "max-age=10, stale-while-revalidate=20")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

"""Serves Borderline Interesting on this computer.

    python scripts/serve.py            # http://127.0.0.1:8765
    python scripts/serve.py 9000

Files are served from the project folder without caching, so edits show on the next reload. Any static server works
too (python -m http.server 8765); this one only adds the no-cache header and handles many parallel tile requests.
"""
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 256
    daemon_threads = True


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = Server(("127.0.0.1", port), functools.partial(Handler, directory=str(ROOT)))
    print(f"Borderline Interesting on http://127.0.0.1:{port}/")
    server.serve_forever()
